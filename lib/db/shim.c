/*
 * SQLite shim for scriptc FFI (format 2: scalar-only callbacks).
 *
 * scriptc's FFI has no pointer params/returns and (in format 2) callbacks can
 * only carry scalars, so this shim owns the sqlite3 handle in a static and
 * streams results back to TypeScript through a u32 callback, 4 bytes per call:
 *
 *   frame  = length_word data_word*
 *   length_word = (byte length of message, < 2^31) | 0x80000000 for the
 *                 once-per-row-producing-statement {"columns":[...]} header
 *   data_word   = big-endian payload bytes, last word zero-padded
 *
 * Messages are UTF-8 JSON: the columns header above, then one array per row
 * (BLOB columns become {"$hex":".."}). Bind parameters are passed in as a
 * JSON array string: null/true/false/number/"text". Multiple statements can
 * be sent in one call; the same params bind to each.
 */
#include <errno.h>
#include <sqlite3.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MSG_COLUMNS 0x80000000u

typedef void (*shim_word_cb)(uint32_t);

static sqlite3 *g_db = NULL;
static char g_err[1024] = "";

/* ---------- growable output buffer ---------- */

typedef struct {
  char *data;
  size_t len, cap;
} buf;

static int buf_reserve(buf *b, size_t extra) {
  size_t need = b->len + extra + 1;
  if (need <= b->cap)
    return 0;
  size_t cap = b->cap ? b->cap : 256;
  while (cap < need)
    cap *= 2;
  char *p = realloc(b->data, cap);
  if (!p)
    return -1;
  b->data = p;
  b->cap = cap;
  return 0;
}

static int buf_putc(buf *b, char c) {
  if (buf_reserve(b, 1))
    return -1;
  b->data[b->len++] = c;
  b->data[b->len] = 0;
  return 0;
}

static int buf_puts(buf *b, const char *s, size_t n) {
  if (buf_reserve(b, n))
    return -1;
  memcpy(b->data + b->len, s, n);
  b->len += n;
  b->data[b->len] = 0;
  return 0;
}

static int buf_putsz(buf *b, const char *s) {
  return buf_puts(b, s, strlen(s));
}

/* Append a JSON-escaped string body (no surrounding quotes). UTF-8 passes
 * through. */
static int buf_json_escape(buf *b, const char *s, size_t n) {
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    switch (c) {
    case '"':
      if (buf_putsz(b, "\\\""))
        return -1;
      break;
    case '\\':
      if (buf_putsz(b, "\\\\"))
        return -1;
      break;
    case '\b':
      if (buf_putsz(b, "\\b"))
        return -1;
      break;
    case '\f':
      if (buf_putsz(b, "\\f"))
        return -1;
      break;
    case '\n':
      if (buf_putsz(b, "\\n"))
        return -1;
      break;
    case '\r':
      if (buf_putsz(b, "\\r"))
        return -1;
      break;
    case '\t':
      if (buf_putsz(b, "\\t"))
        return -1;
      break;
    default:
      if (c < 0x20) {
        char tmp[8];
        snprintf(tmp, sizeof tmp, "\\u%04x", c);
        if (buf_putsz(b, tmp))
          return -1;
      } else if (buf_putc(b, (char)c)) {
        return -1;
      }
    }
  }
  return 0;
}

/* ---------- minimal JSON array parser for bind parameters ---------- */

typedef struct {
  const char *p, *end;
} jp;

static void jp_ws(jp *j) {
  while (j->p < j->end &&
         (*j->p == ' ' || *j->p == '\t' || *j->p == '\n' || *j->p == '\r'))
    j->p++;
}

static int jp_hex4(jp *j, unsigned *out) {
  if (j->end - j->p < 4)
    return -1;
  unsigned v = 0;
  for (int i = 0; i < 4; i++) {
    char c = j->p[i];
    v <<= 4;
    if (c >= '0' && c <= '9')
      v |= (unsigned)(c - '0');
    else if (c >= 'a' && c <= 'f')
      v |= (unsigned)(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F')
      v |= (unsigned)(c - 'A' + 10);
    else
      return -1;
  }
  j->p += 4;
  *out = v;
  return 0;
}

static void jp_utf8(buf *b, unsigned cp) {
  if (cp < 0x80) {
    buf_putc(b, (char)cp);
  } else if (cp < 0x800) {
    buf_putc(b, (char)(0xC0 | (cp >> 6)));
    buf_putc(b, (char)(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    buf_putc(b, (char)(0xE0 | (cp >> 12)));
    buf_putc(b, (char)(0x80 | ((cp >> 6) & 0x3F)));
    buf_putc(b, (char)(0x80 | (cp & 0x3F)));
  } else {
    buf_putc(b, (char)(0xF0 | (cp >> 18)));
    buf_putc(b, (char)(0x80 | ((cp >> 12) & 0x3F)));
    buf_putc(b, (char)(0x80 | ((cp >> 6) & 0x3F)));
    buf_putc(b, (char)(0x80 | (cp & 0x3F)));
  }
}

/* Parse one JSON string body (past the opening quote) into b as raw UTF-8. */
static int jp_string(jp *j, buf *b) {
  /* consume the opening quote */
  if (j->p >= j->end || *j->p != '"')
    return -1;
  j->p++;
  b->len = 0;
  while (j->p < j->end && *j->p != '"') {
    char c = *j->p++;
    if ((unsigned char)c < 0x20)
      return -1;
    if (c != '\\') {
      if (buf_putc(b, c))
        return -1;
      continue;
    }
    if (j->p >= j->end)
      return -1;
    char e = *j->p++;
    switch (e) {
    case '"':
    case '\\':
    case '/':
      if (buf_putc(b, e))
        return -1;
      break;
    case 'b':
      if (buf_putc(b, '\b'))
        return -1;
      break;
    case 'f':
      if (buf_putc(b, '\f'))
        return -1;
      break;
    case 'n':
      if (buf_putc(b, '\n'))
        return -1;
      break;
    case 'r':
      if (buf_putc(b, '\r'))
        return -1;
      break;
    case 't':
      if (buf_putc(b, '\t'))
        return -1;
      break;
    case 'u': {
      unsigned cp;
      if (jp_hex4(j, &cp))
        return -1;
      if (cp >= 0xD800 && cp <= 0xDBFF) {
        unsigned lo = 0;
        jp save = *j;
        if (j->end - j->p >= 6 && j->p[0] == '\\' && j->p[1] == 'u') {
          j->p += 2;
          if (jp_hex4(j, &lo) == 0 && lo >= 0xDC00 && lo <= 0xDFFF)
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          else {
            *j = save;
            cp = 0xFFFD;
          }
        } else {
          cp = 0xFFFD;
        }
      } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
        cp = 0xFFFD;
      }
      jp_utf8(b, cp);
      break;
    }
    default:
      return -1;
    }
  }
  if (j->p >= j->end)
    return -1;
  j->p++;
  return 0;
}

/* Bind a JSON array ([v1, v2, ...]) to stmt parameters 1..n.
 * 0 on success, -1 on parse error, -2 on bind error. */
static int bind_params(sqlite3_stmt *stmt, const char *json, size_t len) {
  if (!json || len == 0)
    return 0;
  jp j = {json, json + len};
  buf s = {0, 0, 0};
  jp_ws(&j);
  if (j.p >= j.end || *j.p != '[')
    goto bad;
  j.p++;
  jp_ws(&j);
  int idx = 1;
  if (j.p < j.end && *j.p == ']')
    return 0;
  for (;;) {
    jp_ws(&j);
    if (j.p >= j.end)
      goto bad;
    char c = *j.p;
    if (c == '"') {
      if (jp_string(&j, &s))
        goto badparse;
      if (sqlite3_bind_text(stmt, idx, s.data ? s.data : "", (int)s.len,
                            SQLITE_TRANSIENT) != SQLITE_OK)
        goto badbind;
    } else if (c == '{' && (size_t)(j.end - j.p) >= 9 &&
               strncmp(j.p, "{\"$hex\":\"", 9) == 0) {
      /* {"$hex":"..."} binds a blob */
      j.p += 9;
      s.len = 0;
      int hi = -1;
      while (j.p < j.end && *j.p != '"') {
        char h = *j.p++;
        int v;
        if (h >= '0' && h <= '9')
          v = h - '0';
        else if (h >= 'a' && h <= 'f')
          v = h - 'a' + 10;
        else if (h >= 'A' && h <= 'F')
          v = h - 'A' + 10;
        else
          goto bad;
        if (hi < 0) {
          hi = v;
        } else {
          if (buf_putc(&s, (char)((hi << 4) | v)))
            goto bad;
          hi = -1;
        }
      }
      if (j.p >= j.end || hi >= 0)
        goto bad;
      j.p++; /* closing quote */
      jp_ws(&j);
      if (j.p >= j.end || *j.p != '}')
        goto bad;
      j.p++;
      if (sqlite3_bind_blob(stmt, idx, s.data ? s.data : "", (int)s.len,
                            SQLITE_TRANSIENT) != SQLITE_OK)
        goto badbind;
    } else if (c == 'n' && (size_t)(j.end - j.p) >= 4 &&
               strncmp(j.p, "null", 4) == 0) {
      j.p += 4;
      sqlite3_bind_null(stmt, idx);
    } else if (c == 't' && (size_t)(j.end - j.p) >= 4 &&
               strncmp(j.p, "true", 4) == 0) {
      j.p += 4;
      sqlite3_bind_int(stmt, idx, 1);
    } else if (c == 'f' && (size_t)(j.end - j.p) >= 5 &&
               strncmp(j.p, "false", 5) == 0) {
      j.p += 5;
      sqlite3_bind_int(stmt, idx, 0);
    } else if (c == '-' || (c >= '0' && c <= '9')) {
      const char *start = j.p;
      while (j.p < j.end && *j.p != ',' && *j.p != ']' && *j.p != ' ' &&
             *j.p != '\t' && *j.p != '\n' && *j.p != '\r')
        j.p++;
      size_t n = (size_t)(j.p - start);
      char tok[64];
      if (n == 0 || n >= sizeof tok)
        goto bad;
      memcpy(tok, start, n);
      tok[n] = 0;
      int isint = 1;
      for (size_t i = 0; i < n; i++) {
        char d = tok[i];
        if (d == '.' || d == 'e' || d == 'E') {
          isint = 0;
          break;
        }
        if ((d < '0' || d > '9') && d != '-' && d != '+')
          goto bad;
      }
      if (isint) {
        errno = 0;
        long long v = strtoll(tok, NULL, 10);
        if (errno == ERANGE) {
          isint = 0;
        } else {
          sqlite3_bind_int64(stmt, idx, (sqlite3_int64)v);
        }
      }
      if (!isint)
        sqlite3_bind_double(stmt, idx, strtod(tok, NULL));
    } else {
      goto bad; /* arrays/objects unsupported */
    }
    idx++;
    jp_ws(&j);
    if (j.p >= j.end)
      goto bad;
    if (*j.p == ',') {
      j.p++;
      continue;
    }
    if (*j.p == ']')
      break;
    goto bad;
  }
  free(s.data);
  return 0;
badbind:
  free(s.data);
  return -2;
badparse:
  free(s.data);
  return -1;
bad:
  free(s.data);
  return -1;
}

/* ---------- framed word delivery ---------- */

static void deliver(shim_word_cb cb, const uint8_t *p, size_t n,
                    uint32_t flag) {
  cb((uint32_t)n | flag);
  size_t i = 0;
  for (; i + 4 <= n; i += 4)
    cb(((uint32_t)p[i] << 24) | ((uint32_t)p[i + 1] << 16) |
       ((uint32_t)p[i + 2] << 8) | (uint32_t)p[i + 3]);
  if (i < n) {
    uint32_t w = 0;
    for (size_t k = 0; k < n - i; k++)
      w |= (uint32_t)p[i + k] << (24 - 8 * k);
    cb(w);
  }
}

/* ---------- row/column emission ---------- */

static int emit_columns(buf *b, sqlite3_stmt *stmt, shim_word_cb cb) {
  b->len = 0;
  if (buf_putsz(b, "{\"columns\":["))
    return -1;
  int n = sqlite3_column_count(stmt);
  for (int i = 0; i < n; i++) {
    if (i && buf_putc(b, ','))
      return -1;
    if (buf_putc(b, '"'))
      return -1;
    const char *name = sqlite3_column_name(stmt, i);
    if (name && buf_json_escape(b, name, strlen(name)))
      return -1;
    if (buf_putc(b, '"'))
      return -1;
  }
  if (buf_putsz(b, "]}"))
    return -1;
  deliver(cb, (const uint8_t *)b->data, b->len, MSG_COLUMNS);
  return 0;
}

static int emit_row(buf *b, sqlite3_stmt *stmt, shim_word_cb cb) {
  b->len = 0;
  if (buf_putc(b, '['))
    return -1;
  int n = sqlite3_column_count(stmt);
  for (int i = 0; i < n; i++) {
    if (i && buf_putc(b, ','))
      return -1;
    switch (sqlite3_column_type(stmt, i)) {
    case SQLITE_NULL:
      if (buf_putsz(b, "null"))
        return -1;
      break;
    case SQLITE_INTEGER: {
      char tmp[32];
      snprintf(tmp, sizeof tmp, "%lld",
               (long long)sqlite3_column_int64(stmt, i));
      if (buf_putsz(b, tmp))
        return -1;
      break;
    }
    case SQLITE_FLOAT: {
      char tmp[40];
      snprintf(tmp, sizeof tmp, "%.17g", sqlite3_column_double(stmt, i));
      if (buf_putsz(b, tmp))
        return -1;
      break;
    }
    case SQLITE_TEXT: {
      const unsigned char *t = sqlite3_column_text(stmt, i);
      int bn = sqlite3_column_bytes(stmt, i);
      if (buf_putc(b, '"'))
        return -1;
      if (t && bn > 0 && buf_json_escape(b, (const char *)t, (size_t)bn))
        return -1;
      if (buf_putc(b, '"'))
        return -1;
      break;
    }
    default: { /* BLOB -> {"$hex":"..."} */
      const uint8_t *p = (const uint8_t *)sqlite3_column_blob(stmt, i);
      int bn = sqlite3_column_bytes(stmt, i);
      if (buf_putsz(b, "{\"$hex\":\""))
        return -1;
      for (int k = 0; k < bn; k++) {
        char tmp[3];
        snprintf(tmp, sizeof tmp, "%02x", p ? p[k] : 0);
        if (buf_putsz(b, tmp))
          return -1;
      }
      if (buf_putsz(b, "\"}"))
        return -1;
      break;
    }
    }
  }
  if (buf_putc(b, ']'))
    return -1;
  deliver(cb, (const uint8_t *)b->data, b->len, 0);
  return 0;
}

/* ---------- exported shim API ---------- */

int shim_open(const uint8_t *filename, size_t len) {
  if (g_db) {
    sqlite3_close(g_db);
    g_db = NULL;
  }
  char *fn = malloc(len + 1);
  if (!fn) {
    snprintf(g_err, sizeof g_err, "out of memory");
    return SQLITE_NOMEM;
  }
  if (len && filename)
    memcpy(fn, filename, len);
  fn[len] = 0;
  /* an empty path opens an in-memory database */
  int rc = sqlite3_open(len ? fn : ":memory:", &g_db);
  if (rc == SQLITE_OK) {
    sqlite3_busy_timeout(g_db, 5000);
  } else {
    snprintf(g_err, sizeof g_err, "%s", sqlite3_errmsg(g_db));
    sqlite3_close(g_db);
    g_db = NULL;
  }
  free(fn);
  return rc;
}

void shim_close(void) {
  if (g_db) {
    sqlite3_close(g_db);
    g_db = NULL;
  }
}

int shim_exec(const uint8_t *sql, size_t sql_len, const uint8_t *params,
              size_t params_len, shim_word_cb row_cb) {
  if (!g_db) {
    snprintf(g_err, sizeof g_err, "database is not open");
    return SQLITE_MISUSE;
  }
  if (!sql || sql_len == 0) {
    snprintf(g_err, sizeof g_err, "empty statement");
    return SQLITE_MISUSE;
  }
  g_err[0] = 0;

  char *zsql = malloc(sql_len + 1);
  if (!zsql) {
    snprintf(g_err, sizeof g_err, "out of memory");
    return SQLITE_NOMEM;
  }
  memcpy(zsql, sql, sql_len);
  zsql[sql_len] = 0;

  buf b = {0, 0, 0};
  int rc = SQLITE_OK;
  char *p = zsql;
  while (*p) {
    sqlite3_stmt *stmt = NULL;
    const char *tail = NULL;
    rc = sqlite3_prepare_v2(g_db, p, -1, &stmt, &tail);
    if (rc != SQLITE_OK) {
      snprintf(g_err, sizeof g_err, "%s", sqlite3_errmsg(g_db));
      break;
    }
    if (!stmt) { /* trailing whitespace/comments only */
      if (tail == p)
        break;
      p = (char *)tail;
      continue;
    }
    int brc = bind_params(stmt, (const char *)params, params_len);
    if (brc != 0) {
      if (brc == -2)
        snprintf(g_err, sizeof g_err, "bind failed: %s", sqlite3_errmsg(g_db));
      else
        snprintf(g_err, sizeof g_err,
                 "invalid params JSON (expected "
                 "[null|true|false|number|\"text\", ...])");
      sqlite3_finalize(stmt);
      rc = SQLITE_ERROR;
      break;
    }
    int emitted = 0;
    for (;;) {
      rc = sqlite3_step(stmt);
      if (rc != SQLITE_ROW)
        break;
      if (!emitted) {
        emitted = 1;
        if (emit_columns(&b, stmt, row_cb)) {
          rc = SQLITE_NOMEM;
          break;
        }
      }
      if (emit_row(&b, stmt, row_cb)) {
        rc = SQLITE_NOMEM;
        break;
      }
    }
    int step_rc = rc;
    sqlite3_finalize(stmt);
    if (step_rc != SQLITE_DONE) {
      snprintf(g_err, sizeof g_err, "%s", sqlite3_errmsg(g_db));
      rc = step_rc;
      break;
    }
    if (tail == p)
      break; /* no progress, avoid looping forever */
    p = (char *)tail;
  }
  rc = (rc == SQLITE_DONE) ? SQLITE_OK : rc;
  free(zsql);
  free(b.data);
  return rc;
}

void shim_last_error(shim_word_cb cb) {
  deliver(cb, (const uint8_t *)g_err, strlen(g_err), 0);
}

int shim_changes(void) { return g_db ? sqlite3_changes(g_db) : 0; }

double shim_last_insert_rowid(void) {
  return g_db ? (double)sqlite3_last_insert_rowid(g_db) : 0;
}

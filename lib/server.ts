import {createServer} from 'http'

const server = createServer((req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/plain',
    })
    res.end('Hello from Node.js server!')
})

server.listen(3000, () => {
    console.log('Server running on port 3000')
})

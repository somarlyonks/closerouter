// eslint-disable-next-line
function toast ({
    title,
    message,
    type = 'info',
    timeout = 3000,
    confirmText,
    cancelText,
    onConfirm,
    onCancel,
    onClose,
}) {
    const $dialog = document.createElement('dialog')
    const position = 'bottom-right'
    $dialog.tabIndex = -1
    $dialog.className = 'toast'
    const [y, x] = position.split('-')
    $dialog.dataset.xPosition = x
    $dialog.dataset.yPosition = y
    $dialog.dataset.type = type

    attachHeader()
    attachContent()
    attachFooter()
    document.body.appendChild($dialog)

    $dialog.addEventListener('close', function () {
        if (onClose) onClose()

        if (this.returnValue === 'confirm' && onConfirm) onConfirm()
        if (this.returnValue === 'cancel' && onCancel) onCancel()

        this.addEventListener('transitionend', function () {
            this.remove()
        })
    })

    setTimeout(() => $dialog.show(), 1)
    if (timeout) setTimeout(() => $dialog.close(), timeout)

    return () => setTimeout(() => $dialog.close(), 1)

    // factory
    function attachHeader () {
        const $header = document.createElement('div')
        $header.className = 'header'

        const $title = document.createElement('span')
        $title.className = 'title'
        $title.textContent = title
        $header.appendChild($title)

        const $form = document.createElement('form')
        $form.method = 'dialog'
        const $button = document.createElement('button')
        $button.value = 'default'
        $button.className = 'button icon button-close'
        $button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><path d="M183.1 137.4C170.6 124.9 150.3 124.9 137.8 137.4C125.3 149.9 125.3 170.2 137.8 182.7L275.2 320L137.9 457.4C125.4 469.9 125.4 490.2 137.9 502.7C150.4 515.2 170.7 515.2 183.2 502.7L320.5 365.3L457.9 502.6C470.4 515.1 490.7 515.1 503.2 502.6C515.7 490.1 515.7 469.8 503.2 457.3L365.8 320L503.1 182.6C515.6 170.1 515.6 149.8 503.1 137.3C490.6 124.8 470.3 124.8 457.8 137.3L320.5 274.7L183.1 137.4z"/></svg>'
        $form.appendChild($button)
        $header.appendChild($form)

        $dialog.appendChild($header)
    }

    function attachContent () {
        if (!message) return

        const $content = document.createElement('div')
        $content.className = 'content'
        $content.textContent = message
        $dialog.appendChild($content)
    }

    function attachFooter () {
        if (!confirmText && !cancelText) return

        const $form = document.createElement('form')
        $form.method = 'dialog'
        $form.className = 'footer'
        if (cancelText) {
            const $button = document.createElement('button')
            $button.value = 'cancel'
            $button.className = 'button button-cancel'
            $button.textContent = cancelText
            $form.appendChild($button)
        }
        if (confirmText) {
            const $button = document.createElement('button')
            $button.value = 'confirm'
            $button.className = 'button button-primary'
            $button.textContent = confirmText
            $form.appendChild($button)
        }
        $dialog.appendChild($form)
    }
}

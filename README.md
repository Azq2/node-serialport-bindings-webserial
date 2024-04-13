# SUMMARY

[![NPM Version](https://img.shields.io/npm/v/serialport-bindings-webserial)](https://www.npmjs.com/package/serialport-bindings-webserial)

[WebSerial](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) bindings for [serialport](https://www.npmjs.com/package/serialport) module.

# INSTALL
1. Install module.
    ```sh
    npm i serialport-bindings-webserial
    ```
2. Import a module into your code:
    ```js
    import { SerialPortStream } from '@serialport/stream';
    import WebSerialBinding from 'serialport-bindings-webserial';
    ```

# EXAMPLES
1. List available and paired ports:
    ```js
    let ports = await WebSerialBinding.list();
    console.log(ports);
    ```
2. Open any port:

    The browser will show pop-up with all available ports.
    ```js
    let port = await new SerialPortStream({
        binding: WebSerialBinding,
        path: 'webserial://any',
        baudRate: 115200
    });
    ```
4. Open any port with filters:

    The browser will show pop-up with all available ports which fit the requested filter.
    ```js
    let webserialRequestOptions = {
        filters: [{ usbVendorId: 0x067B, usbProductId: 0x2303 }]
    };
    
    let port = await new SerialPortStream({
        binding: WebSerialBinding,
        path: 'webserial://any',
        baudRate: 115200,
        webserialRequestOptions
    });
    ```
5. Open with native SerialPort:

    You can open a port using reference to the native SerialPort object.
    ```js
    let nativePort = await navigator.requestPort({});
    
    let port = new SerialPortStream({
        binding: WebSerialBinding,
        path: 'webserial://any',
        baudRate: 115200,
        webserialPort: nativePort
    });
    ```
6. Open port by virtual path:
    ```js
    let ports = await WebSerialBinding.list();
    
    let port = new SerialPortStream({
        binding: WebSerialBinding,
        path: ports[0].path, // for example: webserial://usb0
        baudRate: 115200,
    });
    ```
# NOTES
You need something like `vite-plugin-node-polyfills` or `node-stdlib-browser` for using the `serialport` module in the browser.

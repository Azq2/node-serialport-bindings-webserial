# SUMMARY

[![NPM Version](https://img.shields.io/npm/v/serialport-bindings-webserial)](https://www.npmjs.com/package/serialport-bindings-webserial)

[WebSerial](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) bindings for [serialport](https://www.npmjs.com/package/serialport) module.

# INSTALL
    ```sh
    npm i serialport-bindings-webserial
    yarn add serialport-bindings-webserial
    pnpm add serialport-bindings-webserial
    ```

# EXAMPLES
1. List available and paired ports:
    ```js
    import { WebSerialBinding } from 'serialport-bindings-webserial';
    
    const ports = await WebSerialBinding.list();
    console.log(ports);
    ```
2. Open any port:
    
    The browser will show pop-up with all available ports.
    ```js
    import { WebSerialBinding, WebSerialBindingInterface } from 'serialport-bindings-webserial';
    import { SerialPortStream } from '@serialport/stream';
    
    const port = new SerialPortStream<WebSerialBindingInterface>({
        binding: WebSerialBinding,
        path: 'webserial://any',
        baudRate: 115200
    });
    ```
3. Open any port with custom options for [SerialPort.open](https://developer.mozilla.org/en-US/docs/Web/API/SerialPort/open):

    The browser will show pop-up with all available ports.
    ```js
    import { WebSerialBinding, WebSerialBindingInterface } from 'serialport-bindings-webserial';
    import { SerialPortStream } from '@serialport/stream';
    
    const port = new SerialPortStream<WebSerialBindingInterface>({
        binding: WebSerialBinding,
        path: 'webserial://any',
        baudRate: 115200,
        webSerialOpenOptions: {
            bufferSize: 4 * 1024 // https://developer.mozilla.org/en-US/docs/Web/API/SerialPort/open#buffersize
        }
    }); 
    ```
4. Open any port with filters:

   The browser will show pop-up with all available ports which fit the requested filter.
   ```js
   import { WebSerialBinding, WebSerialBindingInterface } from 'serialport-bindings-webserial'; 
   import { SerialPortStream } from '@serialport/stream';
   
   const port = new SerialPortStream<WebSerialBindingInterface>({
      binding: WebSerialBinding,
      path: 'webserial://any',
      baudRate: 115200,
      webSerialRequestOptions: {
          filters: [{ usbVendorId: 0x067B, usbProductId: 0x2303 }]
      }
   });
   ```
5. Open with native SerialPort:

   You can open a port using reference to the native SerialPort object.
   ```js
   import { WebSerialBinding, WebSerialBindingInterface } from 'serialport-bindings-webserial'; 
   import { SerialPortStream } from '@serialport/stream';
   
   const webSerialPort = await navigator.serial.requestPort();
   
   const port = new SerialPortStream({
      binding: WebSerialBinding,
      path: 'webserial://any',
      baudRate: 115200,
      webSerialPort
   });
   ```
6. Open port by virtual path:
   ```js
   import { WebSerialBinding, WebSerialBindingInterface } from 'serialport-bindings-webserial'; 
   import { SerialPortStream } from '@serialport/stream';
   
   const ports = await WebSerialBinding.list();
   
   const port = new SerialPortStream({
      binding: WebSerialBinding,
      path: ports[0].path, // for example: webserial://usb0
      baudRate: 115200,
   });
   ```
# NOTES
You need something like `vite-plugin-node-polyfills` or `node-stdlib-browser` for using the `serialport` module in the browser.

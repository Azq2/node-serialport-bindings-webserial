import { BindingInterface, BindingPortInterface, PortStatus, SetOptions, UpdateOptions, OpenOptions, PortInfo } from '@serialport/bindings-interface'

export interface WebSerialBindingInterface extends BindingInterface<WebSerialPort, Required<WebSerialOpenOptions>, WebSerialPortInfo> {
	getPortPath(nativePort: SerialPort): Promise<string|null>
}

export interface WebSerialOpenOptions extends OpenOptions {
	webSerialOpenOptions: SerialOptions;
	webSerialRequestOptions: SerialPortRequestOptions;
	webSerialPort: SerialPort;
};

export interface WebSerialPortInfo extends PortInfo {
	nativePort: SerialPort;
};

export interface WebSerialBindingPortInterface {
	getNativePort(): SerialPort;
};

interface WebSerialLock {
	promise: Promise<boolean>;
	resolve: (value: boolean) => void;
	reject: (reason?: any) => void;
};

export class WebSerialPort implements WebSerialBindingPortInterface {
	readonly openOptions: Required<WebSerialOpenOptions>;
	readonly port: SerialPort;
	isOpen = false;
	private lastWriteCall: Promise<void> = null;
	private updatingPortSettings = false;
	private lastSignalsValues: SerialOutputSignals = null;
	private internalBuffer: Uint8Array;
	private locked: WebSerialLock = null;
	private reader: ReadableStreamDefaultReader<Uint8Array> = null;
	private writer: WritableStreamDefaultWriter<Uint8Array> = null;

	constructor(port: SerialPort, openOptions: Required<WebSerialOpenOptions>) {
		this.port = port;
		this.openOptions = {
			baudRate:	115200,
			dataBits:	8,
			stopBits:	1,
			parity:		false,
			rtscts:		false,
			...openOptions
		};
		this.internalBuffer = new Uint8Array(0);
	}

	async open(): Promise<void> {
		await this.lock();

		if (!this.isOpen) {
			await this._open();
			this.isOpen = true;
		}

		this.unlock();
	}

	async close(): Promise<void> {
		await this.lock();
		if (this.isOpen) {
			this.isOpen = false;
			await this._close();
			this.internalBuffer = new Uint8Array(0);
		}
		this.unlock();
	}

	private async _open() {
		await this.port.open({
			baudRate:		this.openOptions.baudRate,
			dataBits:		this.openOptions.dataBits,
			flowControl:	(this.openOptions.rtscts ? "hardware" : "none") as FlowControlType,
			parity:			(this.openOptions.parity ? this.openOptions.parity : "none") as ParityType,
			stopBits:		this.openOptions.stopBits,
			...(this.openOptions.webSerialOpenOptions || {}),
		});

		if (this.port.readable)
			this.reader = this.port.readable.getReader();
		if (this.port.writable)
			this.writer = this.port.writable.getWriter();
	}

	private async _close() {
		if (this.reader) {
			try { await this.reader.cancel(); } catch (e) { }
			this.reader.releaseLock();
			this.reader = null;
		}

		if (this.writer) {
			try { await this.writer.close(); } catch (e) { }
			this.writer.releaseLock();
			this.writer = null;
		}

		this.lastWriteCall = null;

		try { await this.port.close(); } catch (e) { }
	}

	async getBaudRate(): Promise<{baudRate: number}> {
		return { baudRate: this.openOptions.baudRate };
	}

	async update(options: UpdateOptions): Promise<void> {
		await this.lock();

		if (options.baudRate != this.openOptions.baudRate) {
			this.openOptions.baudRate = options.baudRate;
			try {
				this.updatingPortSettings = true;
				await this._close();
				await this._open();
				if (this.lastSignalsValues) {
					// Restore signals
					await this.port.setSignals(this.lastSignalsValues);
				}
				this.updatingPortSettings = false;
			} catch (e) {
				this.updatingPortSettings = false;
				throw e;
			}
		}

		this.unlock();
	}

	async write(buffer: Buffer): Promise<void> {
		this.locked && await this.waitForUnlock();
		return (this.lastWriteCall = this.writer.write(buffer));
	}

	async read(buffer: Buffer, offset: number, length: number): Promise<{buffer: Buffer, bytesRead: number}> {
		// Reuse redundant data from previous read.
		let readedFromInternalBuffer = 0;
		if (this.internalBuffer.length > 0) {
			let availFromBuffer = Math.min(length, this.internalBuffer.length);

			buffer.set(this.internalBuffer.slice(0, availFromBuffer), offset);

			length -= availFromBuffer;
			offset += availFromBuffer;
			readedFromInternalBuffer += availFromBuffer;

			this.internalBuffer = this.internalBuffer.slice(availFromBuffer);

			if (!length)
				return { buffer, bytesRead: readedFromInternalBuffer };
		}

		this.locked && await this.waitForUnlock();

		let readed;
		try {
			readed = await this.reader.read();
		} catch (e) {
			if (!this.updatingPortSettings)
				throw e;
		}

		if (!readed || readed.done) {
			if (this.updatingPortSettings)
				return this.read(buffer, offset, length);
			return { buffer, bytesRead: readedFromInternalBuffer };
		}

		if (readed.value.length > length) {
			// A possibly impossible case when WebSerial returns more data than "node-serial" was requested.
			// We just save any redundant data in an internal buffer and return it on the next read.
			buffer.set(readed.value.slice(0, length), offset);

			let redundantBytes = readed.value.slice(length);

			let newInternalBuffer = new Uint8Array(this.internalBuffer.length + redundantBytes.length)
			newInternalBuffer.set(this.internalBuffer, 0);
			newInternalBuffer.set(redundantBytes, this.internalBuffer.length);
			this.internalBuffer = newInternalBuffer;

			return { buffer, bytesRead: readedFromInternalBuffer + length };
		} else {
			buffer.set(readed.value, offset);
			return { buffer, bytesRead: readedFromInternalBuffer + readed.value.length };
		}
	}

	async drain(): Promise<void> {
		this.locked && await this.waitForUnlock();

		// WebSerial doesn't provide an API for drain, we just wait for the last writing to be finished.
		if (this.lastWriteCall) {
			await this.lastWriteCall;
			this.lastWriteCall = null;
		}
	}

	async flush(): Promise<void> {
		this.locked && await this.waitForUnlock();

		// WebSerial doesn't provide an API for flushing, but we have an internal buffer with redundant data.
		this.internalBuffer = new Uint8Array(0);
	}

	async set(options: SetOptions): Promise<void> {
		this.locked && await this.waitForUnlock();

		this.lastSignalsValues = {
			dataTerminalReady:		options.dtr,
			requestToSend:			options.rts,
			break:					options.brk,
		};

		await this.port.setSignals(this.lastSignalsValues);
	}

	async get(): Promise<PortStatus> {
		this.locked && await this.waitForUnlock();

		let signals = await this.port.getSignals();
		return {
			cts:		signals.clearToSend,
			dsr:		signals.dataSetReady,
			dcd:		signals.dataCarrierDetect,
		};
	}

	getNativePort(): SerialPort {
		return this.port;
	}

	private async lock() {
		this.locked && await this.waitForUnlock();
		let promise: Promise<boolean> = new Promise((resolve, reject) => {
			this.locked = { promise: null, resolve, reject };
		});
		this.locked.promise = promise;
	}

	private unlock() {
		let lock = this.locked;
		if (lock) {
			this.locked = null;
			lock.resolve(true);
		}
	}

	private async waitForUnlock() {
		while (this.locked) {
			await this.locked.promise;
		}
	}
}

function getPortInfo(counters: Record<string, number>, port: SerialPort): WebSerialPortInfo {
	let webInfo: Record<string, any> = port.getInfo();

	let portInfo: WebSerialPortInfo = {
		path:			"",
		manufacturer:	undefined,
		serialNumber:	undefined,
		pnpId:			undefined,
		locationId:		undefined,
		productId:		undefined,
		vendorId:		undefined,
		nativePort:		port,
	};

	let url;

	let path;
	if (webInfo.usbVendorId) {
		url = new URL(`webserial://usb`);
		portInfo.vendorId = webInfo.usbVendorId;
		portInfo.productId = webInfo.usbProductId;
	} else if (webInfo.bluetoothServiceClassId) {
		url = new URL(`webserial://bluetooth`);
	} else {
		url = new URL(`webserial://port`);
	}

	for (let k in webInfo) {
		if (webInfo[k] != null)
			url.searchParams.set(k, webInfo[k]);
	}

	let key = url.toString();
	let portId = counters[key] || 0;

	url.searchParams.set('n', portId.toString());
	portInfo.path = url.toString();

	counters[key] = portId + 1;

	return portInfo;
}

export const WebSerialBinding: WebSerialBindingInterface = {
	async open(options: Required<WebSerialOpenOptions>): Promise<WebSerialPort> {
		let binding: WebSerialPort = null;

		if (!('serial' in navigator))
			throw new Error(`Your browser is not supporting WebSerial API.`);

		if (options.path == "webserial://any") {
			if (options.webSerialPort) {
				binding = new WebSerialPort(options.webSerialPort, options);
			} else {
				let port = await navigator.serial.requestPort(options.webSerialRequestOptions || {});
				binding = new WebSerialPort(port, options);
			}
		} else {
			let ports = await WebSerialBinding.list();
			for (let port of ports) {
				if (port.path === options.path) {
					binding = new WebSerialPort(port.nativePort, options);
					break;
				}
			}
		}

		if (!binding)
			throw new Error(`Invalid port path: ${options.path}`);

		await binding.open();
		return binding;
	},

	async list(): Promise<WebSerialPortInfo[]> {
		let counters: Record<string, number> = {};
		let ports: WebSerialPortInfo[] = [];
		if ('serial' in navigator) {
			for (let port of await navigator.serial.getPorts()) {
				ports.push(getPortInfo(counters, port));
			}
		}
		return ports;
	},

	async getPortPath(nativePort: SerialPort): Promise<string|null> {
		let ports = await WebSerialBinding.list();
		for (let port of ports) {
			if (port.nativePort === nativePort)
				return port.path;
		}
		return null;
	}
};

export default WebSerialBinding;

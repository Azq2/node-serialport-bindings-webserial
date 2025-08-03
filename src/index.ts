import {
	BindingInterface,
	BindingPortInterface,
	OpenOptions,
	PortInfo,
	PortStatus,
	SetOptions,
	UpdateOptions
} from '@serialport/bindings-interface';

export interface WebSerialBindingInterface extends BindingInterface<WebSerialPortBinding, WebSerialOpenOptions, WebSerialPortInfo> {
	getPortPath(nativePort: SerialPort): Promise<string | undefined>
}

export interface WebSerialOpenOptions extends OpenOptions {
	parity?: 'none' | 'even' | 'odd';
	webSerialOpenOptions?: Partial<SerialOptions>;
	webSerialRequestOptions?: SerialPortRequestOptions;
	webSerialPort?: SerialPort | null;
}

export interface WebSerialPortInfo extends PortInfo {
	nativePort: SerialPort;
}

export interface WebSerialBindingPortInterface extends BindingPortInterface {
	getNativePort(): SerialPort;
}

interface WebSerialLock {
	promise?: Promise<boolean>;
	resolve: (value: boolean) => void;
	reject: (reason?: any) => void;
}

export class WebSerialPortBinding implements WebSerialBindingPortInterface {
	readonly openOptions: Required<WebSerialOpenOptions>;
	readonly port: SerialPort;
	isOpen = false;
	private lastWriteCall?: Promise<void>;
	private updatingPortSettings = false;
	private lastSignalsValues?: SerialOutputSignals;
	private internalBuffer: Uint8Array;
	private locked?: WebSerialLock;
	private reader?: ReadableStreamDefaultReader<Uint8Array>;
	private writer?: WritableStreamDefaultWriter<Uint8Array>;

	constructor(port: SerialPort, openOptions: Required<WebSerialOpenOptions>) {
		this.port = port;
		this.openOptions = openOptions;
		this.internalBuffer = new Uint8Array(0);
	}

	async open(): Promise<void> {
		if (!this.isOpen) {
			await this.lock();
			await this._open();
			this.isOpen = true;
			this.unlock();
		}
	}

	async close(): Promise<void> {
		if (this.isOpen) {
			await this.lock();
			this.isOpen = false;
			await this._close();
			this.internalBuffer = new Uint8Array(0);
			this.unlock();
		}
	}

	private async _open() {
		await this.port.open({
			baudRate:		this.openOptions.baudRate,
			dataBits:		this.openOptions.dataBits as SerialOptions["dataBits"],
			flowControl:	(this.openOptions.rtscts ? "hardware" : "none") as FlowControlType,
			parity:			(this.openOptions.parity ? this.openOptions.parity : "none") as ParityType,
			stopBits:		this.openOptions.stopBits as  SerialOptions["stopBits"],
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
			this.reader = undefined;
		}

		if (this.writer) {
			try { await this.writer.close(); } catch (e) { }
			this.writer.releaseLock();
			this.writer = undefined;
		}

		this.lastWriteCall = undefined;

		try { await this.port.close(); } catch (e) { }
	}

	async getBaudRate(): Promise<{baudRate: number}> {
		return { baudRate: this.openOptions.baudRate };
	}

	async update(options: UpdateOptions): Promise<void> {
		if (options.baudRate != this.openOptions.baudRate) {
			await this.lock();
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
			this.unlock();
		}
	}

	async write(buffer: Buffer): Promise<void> {
		this.locked && await this.waitForUnlock();
		return (this.lastWriteCall = this.writer?.write(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)));
	}

	async read(buffer: Buffer, offset: number, length: number): Promise<{buffer: Buffer, bytesRead: number}> {
		// Reuse redundant data from previous read.
		if (this.internalBuffer.length > 0) {
			const availFromBuffer = Math.min(length, this.internalBuffer.length);
			buffer.set(this.internalBuffer.slice(0, availFromBuffer), offset);
			this.internalBuffer = this.internalBuffer.slice(availFromBuffer);
			return { buffer, bytesRead: availFromBuffer };
		}

		this.locked && await this.waitForUnlock();

		let result: ReadableStreamReadResult<Uint8Array<ArrayBufferLike>> | undefined;
		let shouldRepeat = false;
		let reader = this.reader;

		do {
			// Reader closed
			if (!reader)
				return { buffer, bytesRead: 0 };

			try {
				result = await reader.read();
			} catch (e) {
				const shouldIgnoreError =
					this.updatingPortSettings ||
					((e instanceof Error) && ["BreakError", "FramingError", "ParityError", "BufferOverrunError"].includes(e.name));
				console.error(e);
				if (!shouldIgnoreError)
					throw e;
			}

			shouldRepeat = !result || (this.updatingPortSettings && result?.done);

			if (shouldRepeat) {
				this.locked && await this.waitForUnlock();
				reader = this.reader;
				shouldRepeat = true;
			}
		} while (shouldRepeat);

		if (!result?.value) {
			// Stream closed
			return { buffer, bytesRead: 0 };
		} else if (result.value.length > length) {
			// A rare case when WebSerial returns more data than "node-serial" was requested.
			// We just save any redundant data in an internal buffer and return it on the next read.
			buffer.set(result.value.slice(0, length), offset);

			const redundantBytes = result.value.slice(length);
			const newInternalBuffer = new Uint8Array(this.internalBuffer.length + redundantBytes.length);
			newInternalBuffer.set(this.internalBuffer, 0);
			newInternalBuffer.set(redundantBytes, this.internalBuffer.length);
			this.internalBuffer = newInternalBuffer;

			return { buffer, bytesRead: length };
		} else {
			buffer.set(result.value, offset);
			return { buffer, bytesRead: result.value.length };
		}
	}

	async drain(): Promise<void> {
		this.locked && await this.waitForUnlock();

		// WebSerial doesn't provide an API for drain, we just wait for the last writing to be finished.
		if (this.lastWriteCall) {
			await this.lastWriteCall;
			this.lastWriteCall = undefined;
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

		const signals = await this.port.getSignals();
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
		this.locked = usePromiseWithResolvers<boolean>();
	}

	private unlock() {
		const lock = this.locked;
		if (lock) {
			this.locked = undefined;
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
	const webInfo: Record<string, any> = port.getInfo();

	const portInfo: WebSerialPortInfo = {
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
	if (webInfo.usbVendorId) {
		url = new URL(`webserial://usb`);
		portInfo.vendorId = webInfo.usbVendorId;
		portInfo.productId = webInfo.usbProductId;
	} else if (webInfo.bluetoothServiceClassId) {
		url = new URL(`webserial://bluetooth`);
	} else {
		url = new URL(`webserial://port`);
	}

	for (const k in webInfo) {
		if (webInfo[k] != null)
			url.searchParams.set(k, webInfo[k]);
	}

	const key = url.toString();
	const portId = counters[key] || 0;

	url.searchParams.set('n', portId.toString());
	portInfo.path = url.toString();

	counters[key] = portId + 1;

	return portInfo;
}

export const WebSerialBinding: WebSerialBindingInterface = {
	async open(options) {
		let binding: WebSerialPortBinding | undefined;

		const openOptions: Required<WebSerialOpenOptions> = {
			dataBits: 8,
			lock: true,
			stopBits: 1,
			parity: 'none',
			rtscts: false,
			xon: false,
			xoff: false,
			xany: false,
			hupcl: true,
			webSerialOpenOptions: {},
			webSerialRequestOptions: {},
			webSerialPort: null,
			...options
		};

		if (!('serial' in navigator))
			throw new DOMException(`Your browser is not supporting WebSerial API.`, "NotSupportedError");

		if (openOptions.path == "webserial://any") {
			if (openOptions.webSerialPort) {
				binding = new WebSerialPortBinding(openOptions.webSerialPort, openOptions);
			} else {
				const port = await navigator.serial.requestPort(openOptions.webSerialRequestOptions);
				binding = new WebSerialPortBinding(port, openOptions);
			}
		} else {
			const ports = await WebSerialBinding.list();
			for (const port of ports) {
				if (port.path === openOptions.path) {
					binding = new WebSerialPortBinding(port.nativePort, openOptions);
					break;
				}
			}
		}

		if (!binding)
			throw new DOMException(`Invalid port path: ${openOptions.path}`, "NotFoundError");

		await binding.open();
		return binding;
	},

	async list() {
		const counters: Record<string, number> = {};
		let ports: WebSerialPortInfo[] = [];
		if ('serial' in navigator) {
			for (const port of await navigator.serial.getPorts()) {
				ports.push(getPortInfo(counters, port));
			}
		}
		return ports;
	},

	async getPortPath(nativePort) {
		const ports = await WebSerialBinding.list();
		for (const port of ports) {
			if (port.nativePort === nativePort)
				return port.path;
		}
		return undefined;
	}
};

function usePromiseWithResolvers<T>() {
	let resolve: ((value: (PromiseLike<T> | T)) => void) | undefined;
	let reject: ((reason?: any) => void) | undefined;
	const promise = new Promise<T>((_resolve, _reject) => {
		resolve = _resolve;
		reject = _reject;
	});
	return { promise, resolve: resolve!, reject: reject! };
}

export default WebSerialBinding;

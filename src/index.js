class WebSerialPort {
	port;
	options;
	isOpen = false;
	lastWriteCall = null;
	locked = false;
	updatingPortSettings = false;
	lastSignalsValues = null;

	constructor(port, options) {
		this.port = port;
		this.options = {
			baudRate:	115200,
			dataBits:	8,
			stopBits:	1,
			parity:		false,
			rtscts:		false,
			...options
		};
		this.internalBuffer = new Uint8Array(0);
	}

	async open() {
		await this.lock();

		if (!this.isOpen) {
			await this._open();
			this.isOpen = true;
		}

		this.unlock();
	}

	async close() {
		await this.lock();

		if (this.isOpen) {
			this.isOpen = false;
			await this._close();
			this.internalBuffer = new Uint8Array(0);
		}

		this.unlock();
	}

	async _open() {
		await this.port.open({
			baudRate:		this.options.baudRate,
			dataBits:		this.options.dataBits,
			flowControl:	this.options.rtscts ? "hardware" : "none",
			parity:			this.options.parity || "none",
			stopBits:		this.options.stopBits,
			...(this.options.webSerialOpenOptions || {}),
		});

		this.reader = this.port.readable.getReader();
		this.writer = this.port.writable.getWriter();
	}

	async _close() {
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

	async update(newOptions) {
		await this.lock();

		let changed = false;
		for (let k in newOptions) {
			if (this.options[k] != newOptions[k]) {
				this.options[k] = newOptions[k];
				changed = true;
			}
		}

		if (changed) {
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

	async write(data) {
		this.locked && await this.waitForUnlock();
		return (this.lastWriteCall = this.writer.write(data));
	}

	async read(buffer, offset, length) {
		// Reuse redundant data from previous read.
		let readedFromInternalBuffer = 0;
		if (this.internalBuffer.length > 0) {
			let availFromBuffer = Math.min(length, this.internalBuffer.length);

			buffer.set(this.internalBuffer.slice(0, availFromBuffer), offset);

			length -= availFromBuffer;
			offset += availFromBuffer;
			readedFromInternalBuffer += availFromBuffer;

			this.internalBuffer = this.internalBuffer.slice(availFromBuffer);

			if (!length) {
				this.read_cnt--;
				return { bytesRead: readedFromInternalBuffer };
			}
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
			return { bytesRead: readedFromInternalBuffer };
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

			return { bytesRead: readedFromInternalBuffer + length };
		} else {
			buffer.set(readed.value, offset);
			return { bytesRead: readedFromInternalBuffer + readed.value.length };
		}
	}

	async drain() {
		this.locked && await this.waitForUnlock();

		// WebSerial doesn't provide an API for drain, we just wait for the last writing to be finished.
		if (this.lastWriteCall) {
			await this.lastWriteCall;
			this.lastWriteCall = null;
		}
	}

	async flush() {
		this.locked && await this.waitForUnlock();

		// WebSerial doesn't provide an API for flushing, but we have an internal buffer with redundant data.
		this.internalBuffer = new Uint8Array(0);
	}

	async set(options) {
		this.locked && await this.waitForUnlock();

		this.lastSignalsValues = {
			dataTerminalReady:		options.dtr,
			requestToSend:			options.rts,
			break:					options.brk,
		};

		await this.port.setSignals(this.lastSignalsValues);
	}

	async get() {
		this.locked && await this.waitForUnlock();

		let signals = await this.port.getSignals();
		return {
			cts:		signals.clearToSend,
			dsr:		signals.dataSetReady,
			dcd:		signals.dataCarrierDetect,
		};
	}

	async lock() {
		this.locked && await this.waitForUnlock();
		let promise = new Promise((resolve, reject) => {
			this.locked = { resolve, reject };
		});
		this.locked.promise = promise;
	}

	unlock() {
		let lock = this.locked;
		if (lock) {
			this.locked = null;
			lock.resolve();
		}
	}

	async waitForUnlock() {
		while (this.locked) {
			await this.locked.promise;
		}
	}
}

function getPortInfo(counters, port) {
	let webInfo = port.getInfo();

	let portInfo = {
		path:			"",
		manufacturer:	undefined,
		serialNumber:	undefined,
		pnpId:			undefined,
		locationId:		undefined,
		productId:		undefined,
		vendorId:		undefined,
	};

	let url;

	let path;
	if (webInfo.usbVendorId) {
		url = new URL(`webserial://usb`);
		portInfo.usbVendorId = webInfo.usbVendorId;
		portInfo.usbProductId = webInfo.usbProductId;
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

	url.searchParams.set('n', portId);
	portInfo.path = url.toString();

	counters[key] = portId + 1;

	return portInfo;
}

async function open(options) {
	let binding;

	if (options.path == "webserial://any") {
		if (options.webSerialPort) {
			binding = new WebSerialPort(options.webSerialPort, options);
		} else {
			let port = await navigator.serial.requestPort(options.webSerialRequestOptions || {});
			binding = new WebSerialPort(port, options);
		}
	} else {
		let ports = await getPortsMap();
		binding = new WebSerialPort(ports[options.path], options);
	}

	if (!binding)
		throw new Error(`Invalid port path: ${options.path}`);

	await binding.open();
	return binding;
}

async function getPortsMap() {
	let counters = {};
	let map = {};
	for (let port of await navigator.serial.getPorts()) {
		let info = getPortInfo(counters, port);
		map[info.path] = port;
	}
	return map;
}

async function list() {
	let counters = {};
	let ports = [];
	for (let port of await navigator.serial.getPorts()) {
		ports.push(getPortInfo(counters, port));
	}
	return ports;
}

export default { open, list };

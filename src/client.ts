/*
Copyright 2020 toxclient
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { EventEmitter } from "events";
import { Logger } from "./logger";
import * as promisifyAll from "util-promisifyall";
import * as Toxcore from "js-toxcore-c";
import * as fs from "fs";
import { Util } from "./util";

const log = new Logger("Client");

const readFile = promisifyAll(fs).readFileAsync;

export interface IBootstrapNode {
	maintainer?: string;
	address: string;
	port: number;
	key: string;
}

export interface IToxMessage {
	id: string;
	message: string;
	emote: boolean;
}

export interface IToxFile {
	name: string;
	buffer: Buffer;
	size: number;
	sending: boolean;
	kind: "data" | "avatar";
}

interface IMessageQueueEntry {
	type: "text" | "file";
	text?: string;
	emote?: boolean;
	buffer?: Buffer;
}

export class Client extends EventEmitter {
	private tox: Toxcore.Tox;
	private hexFriendLut: Map<string, number>;
	private friendsStatus: Map<number, boolean>;
	private files: Map<string, IToxFile>;
	private friendsMessageQueue: Map<number, IMessageQueueEntry[]>;
	private avatarUrl: string = "";
	private avatarBuffer: Buffer;
	constructor(
		private dataPath: string,
		private nodesPath: string,
		toxcorePath: string,
	) {
		super();
		this.hexFriendLut = new Map();
		this.friendsStatus = new Map();
		this.files = new Map();
		this.friendsMessageQueue = new Map();
		this.tox = promisifyAll(new Toxcore.Tox({
			data: this.dataPath,
			path: toxcorePath,
		}));
	}

	public async connect() {
		await this.bootstrap();

		this.tox.on("friendName", async (e) => {
			const key = await this.getHex(e.friend());
			if (!key) {
				log.error("Public key for friend ${e.friend()} not found! Something went really wrong");
				return;
			}
			log.verbose(`Got new name from key ${key}`);
			this.emit("friendName", key);
		});

		this.tox.on("friendRequest", async (e) => {
			const key = e.publicKey();
			this.emit("friendRequest", key);
		});

		this.tox.on("friendConnectionStatus", async (e) => {
			const friend = e.friend();
			const isConnected = e.isConnected();
			const key = await this.getHex(friend);
			if (!key) {
				log.error("Public key for friend ${e.friend()} not found! Something went really wrong");
				return;
			}
			log.verbose(`User ${key} connection status changed to ${isConnected}`);
			this.friendsStatus.set(friend, isConnected);
			if (isConnected) {
				// no await as we do this in the background
				// tslint:disable-next-line:no-floating-promises
				this.popMessageQueue(friend);
				// no need to await here, either
				// tslint:disable-next-line:no-floating-promises
				this.sendAvatarToFriend(friend);
			}
			this.emit("friendStatus", key, isConnected ? "online" : "offline");
		});

		this.tox.on("friendMessage", async (e) => {
			const key = await this.getHex(e.friend());
			if (!key) {
				log.error("Public key for friend ${e.friend()} not found! Something went really wrong");
				return;
			}
			log.verbose(`Received new message from key ${key}`);
			const message: IToxMessage = {
				id: key,
				message: e.message(),
				emote: e._messageType === Toxcore.Consts.TOX_MESSAGE_TYPE_ACTION,
			};
			this.emit("message", message);
		});

		this.tox.on("friendStatus", async (e) => {
			const key = await this.getHex(e.friend());
			if (!key) {
				log.error("Public key for friend ${e.friend()} not found! Something went really wrong");
				return;
			}
			let status = {
				0: "online",
				1: "away",
				2: "busy",
			}[e.status()];
			if (!status) {
				status = "online";
			}
			log.verbose(`User ${key} status changed to ${status}`);
			this.emit("friendStatus", key, status);
		});

		this.tox.on("friendStatusMessage", async (e) => {
			const key = await this.getHex(e.friend());
			if (!key) {
				log.error("Public key for friend ${e.friend()} not found! Something went really wrong");
				return;
			}
			log.verbose(`User ${key} status message changed to ${e.statusMessage()}`);
			this.emit("friendStatusMessage", key, e.statusMessage());
		});

		this.tox.on("friendTyping", async (e) => {
			const key = await this.getHex(e.friend());
			if (!key) {
				log.error("Public key for friend ${e.friend()} not found! Something went really wrong");
				return;
			}
			log.verbose(`User ${key} typing event to ${e.isTyping()}`);
			this.emit("friendTyping", key, e.isTyping());
		});

		this.tox.on("selfConnectionStatus", async (e) => {
			const status = e.isConnected() ? "connected" : "disconnected";
			log.verbose(`New connection status: ${status}!`);
			if (e.isConnected()) {
				await this.populateFriendList();
			}
			this.emit(status, await this.getFullPubKey());
			if (!e.isConnected()) {
				log.info(`Lost connection, reconnecting...`);
				try {
					await this.bootstrap();
					await this.tox.start();
				} catch (err) {
					log.error("Failed to start client", err);
				}
			}
		});

		// file transmission stuff
		this.tox.on("fileRecvControl", (e) => {
			const fileKey = `${e.friend()};${e.file()}`;
			log.verbose(`Received file control with key ${fileKey}: ${e.controlName()}`);

			if (!this.files.has(fileKey)) {
				return;
			}

			if (e.isPause()) {
				this.files.get(fileKey)!.sending = false;
			}
			if (e.isResume()) {
				this.files.get(fileKey)!.sending = true;
			}

			if (e.isCancel()) {
				this.files.delete(fileKey);
			}
		});

		this.tox.on("fileChunkRequest", async (e) => {
			const fileKey = `${e.friend()};${e.file()}`;
			if (!this.files.has(fileKey)) {
				return;
			}
			const f = this.files.get(fileKey)!;
			const length = e.length();
			const position = e.position();
			log.verbose(`Received file chunk request with key ${fileKey} ` +
				`(length=${length} position=${position} sending=${f.sending})`);

			if (!f.sending) {
				// not sending, ntohing to do
				return;
			}

			if (length === 0) {
				log.verbose("Done sending file");
				delete this.files[fileKey];
				return;
			}
			let sendData = Buffer.alloc(length);
			f.buffer.copy(sendData, 0, position, position + length);

			let done = false;
			if (position + length > f.size) {
				sendData = sendData.slice(0, f.size - position);
				done = true;
				log.verbose("Truncated length to", f.size - position);
			}

			try {
				await this.tox.sendFileChunkAsync(e.friend(), e.file(), position, sendData);
				if (done) {
					log.verbose("Done sending file");
					this.files.delete(fileKey);
					return;
				}
			} catch (err) {
				log.error(`Error sending file with key ${fileKey} (length=${length} position=${position})`, err);
				log.error("Canceling request...");
				await this.tox.controlFileAsync(e.friend(), e.file(), "cancel");
				this.files.delete(fileKey);
				return;
			}
		});

		this.tox.on("fileRecv", async (e) => {
			// TODO: emit receive request and have the implementation accept/reject
			const fileKey = `${e.friend()};${e.file()}`;
			const isAvatar = e.kind() === Toxcore.Consts.TOX_FILE_KIND_AVATAR;
			const fileObj: IToxFile = {
				kind: isAvatar ? "avatar" : "data",
				size: e.size(),
				buffer: Buffer.alloc(0),
				name: e.filename() || "tox_transfer",
				sending: false,
			};
			this.files.set(fileKey, fileObj);
			if (isAvatar) {
				await this.fileControlFriend(e.friend(), e.file(), "resume");
			} else {
				const key = await this.getHex(e.friend());
				if (!key) {
					log.error("Public key for friend ${e.friend()} not found! Something went really wrong");
					return;
				}
				this.emit("fileRecv", key, e.file(), fileObj);
			}
		});

		this.tox.on("fileRecvChunk", async (e) => {
			const fileKey = `${e.friend()};${e.file()}`;
			log.verbose(`Received fileRecvChunk with key ${fileKey}`);
			if (!this.files.has(fileKey)) {
				return;
			}
			const f = this.files.get(fileKey)!;

			if (e.isFinal()) {
				const key = await this.getHex(e.friend());
				log.info(`Received file ${f.name} of kind ${f.kind} from ${key}`);
				// we are done! yay!
				if (f.kind === "avatar") {
					this.emit("friendAvatar", key, f);
				} else {
					this.emit("file", key, f);
				}
				this.files.delete(fileKey);
				return;
			}
			e.data().copy(f.buffer, e.position(), 0, e.length());
		});

		await this.tox.start();
	}

	public async disconnect() {
		await this.tox.stop();
	}

	public async sendMessage(hex: string, text: string, emote: boolean = false) {
		const friend = await this.getFriend(hex);
		if (friend === null) {
			throw new Error("Can't send message to unknown friend");
		}
		await this.sendMessageFriend(friend, text, emote);
	}

	public async sendFile(hex: string, buffer: Buffer, filename: string = "") {
		const friend = await this.getFriend(hex);
		if (friend === null) {
			throw new Error("Can't send file to unknown friend");
		}
		await this.sendFileFriend(friend, buffer, filename);
	}

	public async acceptFile(hex: string, file: number) {
		const friend = await this.getFriend(hex);
		if (friend === null) {
			throw new Error("Can't interact with file of unknown friend");
		}
		await this.fileControlFriend(friend, file, "resume");
	}

	public async resumeFile(hex: string, file: number) {
		const friend = await this.getFriend(hex);
		if (friend === null) {
			throw new Error("Can't interact with file of unknown friend");
		}
		await this.fileControlFriend(friend, file, "resume");
	}

	public async pauseFile(hex: string, file: number) {
		const friend = await this.getFriend(hex);
		if (friend === null) {
			throw new Error("Can't interact with file of unknown friend");
		}
		await this.fileControlFriend(friend, file, "pause");
	}

	public async cancelFile(hex: string, file: number) {
		const friend = await this.getFriend(hex);
		if (friend === null) {
			throw new Error("Can't interact with file of unknown friend");
		}
		await this.fileControlFriend(friend, file, "cancel");
	}

	public async acceptFriend(hex: string) {
		await this.tox.addFriendNoRequestAsync(hex);
		await this.saveToFile();
	}

	public async addFriend(hex: string) {
		await this.tox.addFriendAsync(hex);
		await this.saveToFile();
	}

	public async getSelfUserId() {
		return await this.tox.getAddressHexAsync();
	}

	public async getUserName(hex: string): Promise<string | null> {
		const friend = await this.getFriend(hex);
		if (friend === null) {
			return null;
		}
		const name = await this.tox.getFriendNameAsync(friend);
		return name.replace(/\0/g, "");
	}

	public async setName(name: string) {
		log.verbose(`Setting name to ${name}`);
		await this.tox.setNameAsync(name);
	}

	public async setAvatar(url: string) {
		if (url === this.avatarUrl) {
			return;
		}
		log.verbose(`Setting avatar to ${url}`);
		this.avatarUrl = url;
		const buffer = await Util.DownloadFile(url);
		if (!buffer) {
			log.warn("Avatar buffer is empty");
			return;
		}
		this.avatarBuffer = buffer;
		// we do this async in the background
		// tslint:disable-next-line:no-floating-promises
		this.sendAvatarUpdate();
	}

	public async saveToFile() {
		await this.tox.saveToFileAsync(this.dataPath);
	}

	public async isUserFriend(hex: string): Promise<boolean> {
		const friend = await this.getFriend(hex);
		return friend !== null;
	}

	public async listFriends(): Promise<string[]> {
		const ret: string[] = [];
		await this.populateFriendList();
		const friends = await this.tox.getFriendListAsync();
		for (const f of friends) {
			const key = await this.getHex(f);
			if (key) {
				ret.push(key);
			}
		}
		return ret;
	}

	private async sendAvatarUpdate() {
		for (const [friend, online] of this.friendsStatus) {
			if (online) {
				// we do this async in the background
				// tslint:disable-next-line:no-floating-promises
				this.sendAvatarToFriend(friend);
			}
		}
	}

	private async sendAvatarToFriend(friend: number) {
		if (!this.avatarBuffer) {
			return;
		}
		const filename = "avatar";
		const buffer = this.avatarBuffer;
		const fileNum = await this.tox.sendFileAsync(friend, Toxcore.Consts.TOX_FILE_KIND_AVATAR,
			filename, buffer.byteLength);
		this.files.set(`${friend};${fileNum}`, {
			name: filename,
			buffer,
			kind: "avatar",
			size: buffer.byteLength,
			sending: false,
		});
	}

	private async sendMessageFriend(friend: number, text: string, emote: boolean) {
		try {
			await this.tox.sendFriendMessageAsync(friend, text, emote);
		} catch (err) {
			if (err.code !== Toxcore.Consts.TOX_ERR_FRIEND_SEND_MESSAGE_FRIEND_NOT_CONNECTED || this.isFriendConnected(friend)) {
				throw err;
			}
			log.info(`Friend ${friend} offline, appending message to queue`);
			if (!this.friendsMessageQueue.has(friend)) {
				this.friendsMessageQueue.set(friend, []);
			}
			this.friendsMessageQueue.get(friend)!.push({
				type: "text",
				text,
				emote,
			});
		}
	}

	private async sendFileFriend(friend: number, buffer: Buffer, filename: string = "") {
		try {
			const fileNum = await this.tox.sendFileAsync(friend, Toxcore.Consts.TOX_FILE_KIND_DATA, filename, buffer.byteLength);
			const fileKey = `${friend};${fileNum}`;
			this.files.set(fileKey, {
				name: filename,
				buffer,
				kind: "data",
				size: buffer.byteLength,
				sending: false,
			});
			log.verbose(`Started sending file with key ${fileKey}`);
		} catch (err) {
			if (err.code !== Toxcore.Consts.TOX_ERR_FILE_SEND_FRIEND_NOT_CONNECTED || this.isFriendConnected(friend)) {
				throw err;
			}
			log.info(`Friend ${friend} offline, appending file to queue`);
			if (!this.friendsMessageQueue.has(friend)) {
				this.friendsMessageQueue.set(friend, []);
			}
			this.friendsMessageQueue.get(friend)!.push({
				type: "file",
				text: filename,
				buffer,
			});
		}
	}

	private async fileControlFriend(friend: number, file: number, control: string) {
		const fileKey = `${friend};${file}`;
		if (!this.files.has(fileKey)) {
			log.verbose("unknown file");
			return;
		}
		const f = this.files.get(fileKey)!;
		f.sending = control === "resume";
		if (f.sending && f.buffer.length === 0) {
			f.buffer = Buffer.alloc(f.size);
		}
		await this.tox.controlFileAsync(friend, file, control);
	}

	private async getFriend(hex: string): Promise<number | null> {
		if (this.hexFriendLut.has(hex)) {
			return this.hexFriendLut.get(hex)!;
		}
		await this.populateFriendList();
		const f = this.hexFriendLut.get(hex);
		return f || f === 0 ? f : null;
	}

	private async getHex(friend: number): Promise<string | null> {
		const hex = await this.tox.getFriendPublicKeyHexAsync(friend);
		return hex || null;
	}

	private async populateFriendList() {
		const friends = await this.tox.getFriendListAsync();
		log.verbose(`Received friends list: ${friends}`);
		for (const f of friends) {
			const hex = await this.tox.getFriendPublicKeyHexAsync(f);
			this.hexFriendLut.set(hex, f);
		}
	}

	private isFriendConnected(friend: number): boolean {
		return this.friendsStatus.get(friend) || false;
	}

	private async popMessageQueue(friend: number) {
		log.info(`Popping message queue for friend ${friend}...`);
		if (!this.friendsMessageQueue.has(friend)) {
			log.verbose("Queue empty!");
			return; //  nothing to do
		}
		const queue = this.friendsMessageQueue.get(friend);
		if (!queue || queue.length === 0) {
			log.verbose("Queue empty!");
			return; //  nothing to do
		}
		let item: IMessageQueueEntry | undefined = queue.shift();
		while (item) {
			if (item.type === "text") {
				await this.sendMessageFriend(friend, item.text!, item.emote!);
			} else if (item.type === "file") {
				await this.sendFileFriend(friend, item.buffer!, item.text!);
			}
			item = queue.shift();
		}
	}

	private async getFullPubKey(): Promise<string> {
		// tslint:disable:no-bitwise no-magic-numbers
		let key = await this.tox.getPublicKeyAsync();
		const nospam = Buffer.alloc(4);
		nospam.writeUInt32BE(await this.tox.getNospamAsync(), 0);
		key = Buffer.concat([key, nospam]);

		const checksum = Buffer.alloc(2);
		checksum.writeUInt16BE(0, 0);
		for (let i = 0; i < key.byteLength; i += 2) {
			checksum[0] ^= key[i];
			checksum[1] ^= key[i + 1];
		}

		key = Buffer.concat([key, checksum]);
		return key.toString("hex");
		// tslint:enable:no-bitwise no-magic-numbers
	}

	private async bootstrap() {
		const nodesData = await readFile(this.nodesPath);
		try {
			const nodes = JSON.parse(nodesData) as IBootstrapNode[];
			for (const node of nodes) {
				await this.tox.bootstrap(node.address, node.port, node.key);
			}
		} catch (err) {
			log.error("Failed to bootstrap:", err);
		}
	}
}

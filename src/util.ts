/*
Copyright 2019, 2020 toxclient
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

import * as request from "request-promise";
import * as fs from "fs";
import { DefaultNodes } from "./defaultnodes";
import { IBootstrapNode } from "./client";
import { Logger } from "./logger";

const log = new Logger("Util");

export class Util {
	// tslint:disable-next-line no-any
	public static async DownloadFile(url: string, options: any = {}): Promise<Buffer> {
		if (!options.method) {
			options.method = "GET";
		}
		options.url = url;
		options.encoding = null;
		return await request(options);
	}

	public static async UpdateBootstrapNodesFile(filePath: string) {
		let currentNodes: IBootstrapNode[] = [];
		try {
			const currentNodesData = fs.readFileSync(filePath).toString("utf-8");
			currentNodes = JSON.parse(currentNodesData);
		} catch (err) {
			log.warn("Current bootstrap nodes file is invalid json, using blank one", err);
			currentNodes = DefaultNodes;
		}
		let newNodesData: any = {}; // tslint:disable-line no-any
		try {
			const str = (await Util.DownloadFile("https://nodes.tox.chat/json")).toString("utf-8");
			newNodesData = JSON.parse(str);
		} catch (err) {
			log.warn("Unable to fetch node bootstrap list, doing nothing", err);
			return;
		}
		if (!newNodesData.nodes) {
			log.warn("fetched nodes data isn't an array, doing nothing");
			return;
		}
		for (const node of newNodesData.nodes) {
			const index = currentNodes.findIndex((n) => n.key === node.public_key);
			const nodeData = {
				key: node.public_key,
				port: node.port,
				address: node.ipv4,
				maintainer: node.maintainer,
			} as IBootstrapNode;
			if (index !== -1) {
				currentNodes[index] = nodeData;
			} else {
				currentNodes.push(nodeData);
			}
		}
		try {
			fs.writeFileSync(filePath, JSON.stringify(currentNodes));
		} catch (err) {
			log.error("Unable to write new nodes file", err);
		}
	}
}

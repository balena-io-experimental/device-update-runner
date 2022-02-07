import cors from 'cors';
import express from 'express';

import { getSdk, Device } from 'balena-sdk';

const env = ['BALENA_API_KEY', 'BALENA_DEVICES', `BALENA_RELEASES`];

// Check required configs first
const config = env
	.map((v) => {
		if (process.env[v] == null) {
			throw new Error(`Expected ${v} to be set as environment variable.`);
		}

		return { [v]: process.env[v]!.split(',').filter((s) => !!s) };
	})
	// Convert to object
	.reduce((conf, o) => ({ ...conf, ...o }));

// Default endpoint
const API_ENDPOINT = process.env.API_ENDPOINT || 'https://api.balena-cloud.com';

// Default update cycle interval (in ms, defaults to 5 minutes)
const UPDATE_INTERVAL =
	process.env.UPDATE_INTERVAL != null
		? parseInt(process.env.UPDATE_INTERVAL, 10)
		: 300000;

if (config.BALENA_RELEASES.length < 2) {
	throw new Error(`Expected BALENA_RELEASE to contain at least 2 values`);
}

// SDK
const balena = getSdk({
	apiUrl: API_ENDPOINT,
});

// Release counter, releases will be updated to the next release in the list
// module
let count = 0;

const app = express();

app.use(cors());

async function delay(ms: number) {
	return await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pinToNextRelease(devices: Device[]) {
	const nextRelease = config.BALENA_RELEASES[count];

	devices
		.filter((d) => !d.is_online)
		.forEach((d) =>
			console.log(`Ignoring offline device ${d.device_name} (uuid: ${d.uuid})`),
		);

	const online = devices.filter((d) => d.is_online);

	console.log(`Pinning online devices to release ${nextRelease}`);
	await Promise.all(
		online.map((d) => balena.models.device.pinToRelease(d.uuid, nextRelease)),
	);

	// Rotate over the release list
	count = (count + 1) % config.BALENA_RELEASES.length;

	console.log(
		`Waiting ${
			UPDATE_INTERVAL / 1000
		}s before marking the update as successful`,
	);

	// Wait 5 minutes
	await delay(UPDATE_INTERVAL);

	// Get the pin status of the devices
	const updated = await balena.pine.get({
		resource: 'device',
		options: {
			$filter: {
				uuid: { $in: online.map((d) => d.uuid) },
			},
			$expand: 'is_running__release',
		},
	});

	// Log
	updated.forEach((d) => {
		if (d.is_running__release?.[0]?.commit === nextRelease) {
			console.log(
				`Device ${d.uuid} successfully pinned to release ${nextRelease}`,
			);
		} else {
			console.error(
				`Device ${d.uuid} failed to update to release ${nextRelease}`,
			);
		}
	});
}

async function update(): Promise<void> {
	try {
		const devices = await Promise.all(
			config.BALENA_DEVICES.map((uuid) => balena.models.device.get(uuid)),
		);
		await pinToNextRelease(devices);
	} catch (e) {
		console.error(
			`Failed to update devices to next release, retrying in ${
				UPDATE_INTERVAL / 1000
			}s`,
		);
	}

	// Wait 5 minutes before trying next release
	delay(UPDATE_INTERVAL);

	return update();
}

// Endpoint to trigger immediate update
app.post('/update', async (_, res) => {
	const devices = await Promise.all(
		config.BALENA_DEVICES.map((uuid) => balena.models.device.get(uuid)),
	);
	await pinToNextRelease(devices);
	res.status(201).send('OK');
});

app.listen(3000, async () => {
	// Login to balena
	await balena.auth.loginWithToken(config.BALENA_API_KEY[0]);

	// Start updating
	update();

	console.log('Server listening on port 3000');
});

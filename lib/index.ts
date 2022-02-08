import cors from 'cors';
import express from 'express';
import { createMachine, assign, interpret } from 'xstate';

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

async function pinToNextRelease(devices: Device[]): Promise<string[]> {
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
	return updated
		.map((d) => {
			if (d.is_running__release?.[0]?.commit === nextRelease) {
				console.log(
					`Device ${d.uuid} successfully pinned to release ${nextRelease}`,
				);
				return d.uuid;
			} else {
				console.error(
					`Device ${d.uuid} failed to update to release ${nextRelease}. Ignoring for next release`,
				);
				return null;
			}
		})
		.filter((d) => d != null) as string[];
}

// Use a state machine to control the update cycle
const updater = createMachine<{ uuids: string[] }>({
	id: 'updater',
	initial: 'updating',
	context: {
		uuids: config.BALENA_DEVICES,
	},
	states: {
		waiting: {
			entry: () =>
				console.log(`Waiting ${UPDATE_INTERVAL / 1000}s for next release`),
			after: { [UPDATE_INTERVAL]: 'updating' },
		},
		updating: {
			invoke: {
				id: 'update',
				src: (context) =>
					// Get the list of device data and pin to next release
					Promise.all(
						context.uuids.map((uuid) => balena.models.device.get(uuid)),
					).then((devices) => pinToNextRelease(devices)),
				onDone: {
					target: 'waiting',
					// pinToNextRelease returns the uuids of the devices still running
					actions: assign({ uuids: (_, event) => event.data }),
				},
				onError: {
					target: 'waiting',
					actions: (c, e) => {
						console.error('Failed to update devices to next release', c, e);
					},
				},
			},
		},
		cancelled: {
			type: 'final',
		},
	},
	on: {
		CANCEL: {
			target: 'cancelled',
			actions: () => console.log('Stopped update cycle'),
		},
	},
});

let cancel = () => {
	/* do nothing by default */
};

function start() {
	const i = interpret(updater).start();

	return () => i.send('CANCEL');
}

// Endpoint to trigger immediate update on all devices
app.post('/reset', async (_, res) => {
	/* stop the previouse execution */
	cancel();

	/* start a new instance */
	cancel = start();

	res.status(201).send('OK');
});

app.listen(3000, async () => {
	// Login to balena
	await balena.auth.loginWithToken(config.BALENA_API_KEY[0]);

	// Start updating
	cancel = start();

	console.log('Server listening on port 3000');
});

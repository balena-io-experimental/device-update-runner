# Device update runner

Receives one or more devices to control, accessible through a given device API key and updates them in sequence through a list of releases.
This is intended to test the robustness of the update process of a balena app and catch any issues that may occur.

## Environment variables

**Required variables**

- `BALENA_API_KEY`, user API key with access to the balena devices
- `BALENA_DEVICES`, comma separated list of device uuids to update
- `BALENA_RELEASES`, comma separated list of release uuids to cycle through (must be >=2)

**Optional variables**

- `API_ENDPOINT`, defaults to `https://api.balena-cloud.com`, set to a diferent value to run against a different environment
- `UPDATE_INTERVAL`, defaults to `300000` (ms), this is the time the runner will wait before checking for a successful update as well as the interval between updates


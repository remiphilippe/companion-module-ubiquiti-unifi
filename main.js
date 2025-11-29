// @ts-check
/* global fetch */

import { InstanceBase, InstanceStatus, runEntrypoint } from '@companion-module/base'
import pQueue from 'p-queue'
import https from 'https'
import { getActionDefinitions } from './actions.js'
import { getConfigFields } from './config.js'
import { UpgradeScripts } from './upgrades.js'

// Create a global HTTPS agent for SSL bypass
/** @type {https.Agent | null} */
let insecureAgent = null

/**
 * Get or create an HTTPS agent that bypasses SSL verification
 * @returns {https.Agent}
 */
function getInsecureAgent() {
	if (!insecureAgent) {
		insecureAgent = new https.Agent({
			rejectUnauthorized: false,
		})
	}
	return insecureAgent
}

/**
 * @extends {InstanceBase<any, any>}
 */
export class UnifiInstance extends InstanceBase {
	queue = new pQueue({
		concurrency: 1,
	})

	/**
	 * @type {string | null}
	 */
	siteUuid = null

	/**
	 * @type {Map<string, string>}
	 */
	deviceMacToUuid = new Map()

	connectionCheckInterval = 30000
	/**
	 * @type {NodeJS.Timer | null}
	 */
	connectionCheckTimer = null

	/**
	 * @type {import('@companion-module/base').DropdownChoice[]}
	 */
	portProfileOptions = []
	/**
	 * @type {import('@companion-module/base').DropdownChoice[]}
	 */
	switchMacAddressOptions = []

	getConfigFields() {
		return getConfigFields()
	}

	/**
	 * Conditional debug logger honoring config.verbose
	 * @param {string} message
	 */
	debug(message) {
		if (this.config?.verbose) {
			this.log('debug', message)
		}
	}

	/**
	 * @param {any} config
	 */
	async init(config) {
		this.config = config

		this.updateStatus(InstanceStatus.Connecting)

		this.setActionDefinitions(getActionDefinitions(this))

		await this.configUpdated(config)

		this.connectionCheckTimer = setInterval(async () => {
			if (this.config.apiKey) {
				try {
					await this.apiRequest('GET', '/v1/info')
					this.updateStatus(InstanceStatus.Ok)
				} catch (e) {
					const err = /** @type {Error} */ (e)
					this.log('error', `Connection check failed: ${err?.message ?? err}`)
					this.debug(`Connection check error details: ${String(err && err.stack ? err.stack : err)}`)
					this.updateStatus(InstanceStatus.ConnectionFailure)
				}
			}
		}, this.connectionCheckInterval)
	}

	/**
	 * Make a legacy API request (for port configuration)
	 * @param {string} method
	 * @param {string} path
	 * @param {any} [body]
	 * @returns {Promise<any>}
	 */
	async legacyApiRequest(method, path, body = null) {
		if (!this.config.apiKey) {
			throw new Error('API Key not configured')
		}

		// Legacy API uses site name, not UUID
		const siteName = this.config.site || 'default'
		const legacyPath = path.replace('<SITE>', siteName)
		const url = `https://${this.config.host}:${this.config.port}/api${legacyPath}`

		/** @type {any} */
		const options = {
			method,
			headers: {
				Authorization: `Bearer ${this.config.apiKey}`,
				'Content-Type': 'application/json',
			},
		}

		if (!this.config.sslverify) {
			options.agent = getInsecureAgent()
		}

		if (body) {
			options.body = JSON.stringify(body)
		}

		this.debug(`LEGACY REQUEST ${method} ${url}${body ? ` body=${JSON.stringify(body)}` : ''}`)
		const response = await fetch(url, options)
		this.debug(`LEGACY RESPONSE ${method} ${url} status=${response.status}`)

		if (!response.ok) {
			const errorText = await response.text()
			let errorData
			try {
				errorData = JSON.parse(errorText)
			} catch {
				errorData = { message: errorText }
			}
			this.debug(`LEGACY ERROR ${method} ${url} status=${response.status} body=${errorText}`)
			throw new Error(errorData.message || `API Error: ${response.status} ${response.statusText}`)
		}

		if (response.status === 204 || response.headers.get('content-length') === '0') {
			return null
		}

		const result = await response.json()
		// Legacy API wraps responses in { meta: {...}, data: [...] }
		this.debug(`LEGACY RESULT ${method} ${url} payload=${JSON.stringify(result).slice(0, 1000)}`)
		return result.data || result
	}

	/**
	 * Make an API request to the UniFi controller
	 * @param {string} method
	 * @param {string} path
	 * @param {any} [body]
	 * @returns {Promise<any>}
	 */
	async apiRequest(method, path, body = null) {
		if (!this.config.apiKey) {
			throw new Error('API Key not configured')
		}

		const url = `https://${this.config.host}:${this.config.port}/integration${path}`

		/** @type {any} */
		const options = {
			method,
			headers: {
				Authorization: `Bearer ${this.config.apiKey}`,
				'Content-Type': 'application/json',
			},
		}

		if (!this.config.sslverify) {
			options.agent = getInsecureAgent()
		}

		if (body) {
			options.body = JSON.stringify(body)
		}

		this.debug(`API REQUEST ${method} ${url}${body ? ` body=${JSON.stringify(body)}` : ''}`)
		const response = await fetch(url, options)
		this.debug(`API RESPONSE ${method} ${url} status=${response.status}`)

		if (!response.ok) {
			const errorText = await response.text()
			let errorData
			try {
				errorData = JSON.parse(errorText)
			} catch {
				errorData = { message: errorText }
			}
			this.debug(`API ERROR ${method} ${url} status=${response.status} body=${errorText}`)
			throw new Error(errorData.message || `API Error: ${response.status} ${response.statusText}`)
		}

		if (response.status === 204 || response.headers.get('content-length') === '0') {
			return null
		}

		const payload = await response.json()
		this.debug(`API RESULT ${method} ${url} payload=${JSON.stringify(payload).slice(0, 1000)}`)
		return payload
	}

	/**
	 * Get or discover the site UUID
	 * @returns {Promise<string>}
	 */
	async getSiteUuid() {
		if (this.siteUuid) {
			return /** @type {string} */ (this.siteUuid)
		}

		if (this.config.siteUuid) {
			this.siteUuid = this.config.siteUuid
			return /** @type {string} */ (this.siteUuid)
		}

		// Discover site UUID from site name
		try {
			const siteName = this.config.site || 'default'
			const filter = `internalReference.eq('${siteName}')`
			const response = await this.apiRequest('GET', `/v1/sites?filter=${encodeURIComponent(filter)}`)

			if (response.data && response.data.length > 0) {
				this.siteUuid = response.data[0].id
				this.log('info', `Discovered site UUID: ${this.siteUuid} for site: ${siteName}`)
				return /** @type {string} */ (this.siteUuid)
			}

			throw new Error(`Site '${siteName}' not found`)
		} catch (e) {
			const err = /** @type {Error} */ (e)
			this.log('error', `Failed to discover site UUID: ${err?.message ?? err}`)
			throw e
		}
	}

	/**
	 * Get device UUID from MAC address
	 * @param {string} macAddress
	 * @returns {Promise<string>}
	 */
	async getDeviceUuid(macAddress) {
		if (this.deviceMacToUuid.has(macAddress)) {
			return /** @type {string} */ (this.deviceMacToUuid.get(macAddress))
		}

		// Refresh device list
		await this.refreshDeviceList()

		if (this.deviceMacToUuid.has(macAddress)) {
			return /** @type {string} */ (this.deviceMacToUuid.get(macAddress))
		}

		throw new Error(`Device with MAC address ${macAddress} not found`)
	}

	/**
	 * Refresh the device list from the API
	 */
	async refreshDeviceList() {
		try {
			const siteUuid = await this.getSiteUuid()
			const response = await this.apiRequest('GET', `/v1/sites/${siteUuid}/devices?limit=200`)

			if (response.data) {
				this.deviceMacToUuid.clear()
				for (const device of response.data) {
					if (device.macAddress) {
						this.deviceMacToUuid.set(device.macAddress, device.id)
					}
				}
			}
		} catch (e) {
			const err = /** @type {Error} */ (e)
			this.log('warn', `Failed to refresh device list: ${err?.message ?? err}`)
		}
	}

	async #refreshActionInfo() {
		try {
			const siteUuid = await this.getSiteUuid()
			const response = await this.apiRequest('GET', `/v1/sites/${siteUuid}/devices?limit=200`)

			if (response.data) {
				this.switchMacAddressOptions = response.data
					.filter((/** @type {any} */ device) => device.features && device.features.includes('switching'))
					.map((/** @type {any} */ device) => ({
						id: device.macAddress,
						label: `${device.name} (${device.macAddress})`,
					}))

				// Cache MAC to UUID mapping
				for (const device of response.data) {
					if (device.macAddress) {
						this.deviceMacToUuid.set(device.macAddress, device.id)
					}
				}
			}
		} catch (e) {
			const err = /** @type {Error} */ (e)
			this.log('warn', `Failed to load device list: ${err?.message ?? err}`)
		}

		// Load port profiles from legacy API
		try {
			const portProfiles = await this.legacyApiRequest('GET', '/s/<SITE>/rest/portconf')
			if (portProfiles && Array.isArray(portProfiles)) {
				this.portProfileOptions = portProfiles.map((profile) => ({
					id: profile.name,
					label: profile.name,
				}))
			}
		} catch (e) {
			const err = /** @type {Error} */ (e)
			this.log('warn', `Failed to load port profiles: ${err?.message ?? err}`)
			this.portProfileOptions = []
		}

		this.setActionDefinitions(getActionDefinitions(this))
	}

	/**
	 * @param {any} config
	 */
	async configUpdated(config) {
		this.config = config

		if (!this.config.apiKey) {
			this.updateStatus(InstanceStatus.BadConfig, 'API Key not configured')
			return
		}

		this.updateStatus(InstanceStatus.Connecting)

		// Clear cached data
		this.siteUuid = null
		this.deviceMacToUuid.clear()
		this.portProfileOptions = []
		this.switchMacAddressOptions = []

		// Test connection and load initial data
		try {
			await this.apiRequest('GET', '/v1/info')
			await this.#refreshActionInfo()
			this.updateStatus(InstanceStatus.Ok)
		} catch (e) {
			const err = /** @type {Error} */ (e)
			this.log('error', `Connection failed: ${err?.message ?? err}`)
			this.debug(`Config update connection error details: ${String(err && err.stack ? err.stack : err)}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, err?.message)
		}
	}

	async destroy() {
		if (this.connectionCheckTimer) {
			clearInterval(/** @type {any} */ (this.connectionCheckTimer))
			this.connectionCheckTimer = null
		}

		this.siteUuid = null
		this.deviceMacToUuid.clear()
	}

	/**
	 * @param {string} switch_mac
	 * @param {number} port_idx
	 */
	async doPowerCyclePort(switch_mac, port_idx) {
		try {
			const siteUuid = await this.getSiteUuid()
			const deviceUuid = await this.getDeviceUuid(switch_mac)

			await this.apiRequest(
				'POST',
				`/v1/sites/${siteUuid}/devices/${deviceUuid}/interfaces/ports/${port_idx}/actions`,
				{ action: 'POWER_CYCLE' }
			)

			this.log('info', `Power cycled port ${port_idx} on device ${switch_mac}`)
		} catch (e) {
			this.handleErrors(e, `Power cycle port ${switch_mac}@${port_idx}`)
			throw e
		}
	}

	/**
	 * @param {string} switch_mac
	 * @param {number} port_idx
	 * @param {string} poe_mode
	 */
	async changePortPOEMode(switch_mac, port_idx, poe_mode) {
		try {
			const siteUuid = await this.getSiteUuid()
			const deviceUuid = await this.getDeviceUuid(switch_mac)

			// First, get the device details from Integration API to get device _id
			const device = await this.apiRequest('GET', `/v1/sites/${siteUuid}/devices/${deviceUuid}`)

			// Get full device config from legacy API
			const deviceDetails = await this.legacyApiRequest('GET', `/s/<SITE>/rest/device/${device.macAddress}`)

			if (!deviceDetails || deviceDetails.length === 0) {
				throw new Error('Device not found')
			}

			const fullDevice = deviceDetails[0]
			const deviceId = fullDevice._id
			const portOverrides = fullDevice.port_overrides || []

			// Find or create port override
			const selectedPort = portOverrides.find((/** @type {any} */ port) => port.port_idx == port_idx)
			if (selectedPort) {
				selectedPort.poe_mode = poe_mode
			} else {
				portOverrides.push({
					port_idx: Number(port_idx),
					poe_mode: poe_mode,
				})
			}

			// Update device via legacy API
			await this.legacyApiRequest('PUT', `/s/<SITE>/rest/device/${deviceId}`, {
				port_overrides: portOverrides,
			})

			this.log('info', `Changed POE mode on port ${port_idx} of device ${switch_mac} to ${poe_mode}`)
		} catch (e) {
			this.handleErrors(e, `Change port POE mode ${switch_mac}@${port_idx}`)
			throw e
		}
	}

	/**
	 * @param {string} profile_name
	 * @param {string} poe_mode
	 */
	async changePortProfilePOEMode(profile_name, poe_mode) {
		try {
			// Get port profiles from legacy API
			const portProfiles = await this.legacyApiRequest('GET', '/s/<SITE>/rest/portconf')

			const profileConfig = portProfiles.find((/** @type {any} */ profile) => profile.name == profile_name)
			if (!profileConfig) {
				throw new Error('Port profile not found')
			}

			// Update profile via legacy API
			await this.legacyApiRequest('PUT', `/s/<SITE>/rest/portconf/${profileConfig._id}`, {
				...profileConfig,
				poe_mode: poe_mode,
			})

			this.log('info', `Changed POE mode on profile ${profile_name} to ${poe_mode}`)
		} catch (e) {
			this.handleErrors(e, `Change port profile POE mode ${profile_name}`)
			throw e
		}
	}

	/**
	 * @param {any} err
	 * @param {string} context
	 */
	handleErrors(err, context) {
		const message = err?.message ?? String(err)
		this.log('error', `${context}: ${message}`)
	}
}

runEntrypoint(UnifiInstance, UpgradeScripts)

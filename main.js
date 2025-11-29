// @ts-check

import { InstanceBase, InstanceStatus, runEntrypoint } from '@companion-module/base'
import pQueue from 'p-queue'
import { getActionDefinitions } from './actions.js'
import { getConfigFields } from './config.js'
import { UpgradeScripts } from './upgrades.js'

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

	async init(config) {
		this.config = config

		this.updateStatus(InstanceStatus.Connecting)

		this.setActionDefinitions(getActionDefinitions(this))

		await this.configUpdated(config)

		this.connectionCheckTimer = setInterval(async () => {
			if (this.config.apiKey) {
				try {
					await this.apiRequest('GET', '/v1/info')
					if (this.getStatus() !== InstanceStatus.Ok) {
						this.updateStatus(InstanceStatus.Ok)
					}
				} catch (e) {
					this.log('error', `Connection check failed: ${e?.message ?? e}`)
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

		const siteUuid = await this.getSiteUuid()
		// Legacy API uses site name, not UUID
		const siteName = this.config.site || 'default'
		const legacyPath = path.replace('<SITE>', siteName)
		const url = `https://${this.config.host}:${this.config.port}/api${legacyPath}`

		const options = {
			method,
			headers: {
				'Authorization': `Bearer ${this.config.apiKey}`,
				'Content-Type': 'application/json',
			},
		}

		if (!this.config.sslverify) {
			// @ts-ignore - Node 18+ supports this
			options.agent = new (await import('https')).Agent({
				rejectUnauthorized: false,
			})
		}

		if (body) {
			options.body = JSON.stringify(body)
		}

		const response = await fetch(url, options)

		if (!response.ok) {
			const errorText = await response.text()
			let errorData
			try {
				errorData = JSON.parse(errorText)
			} catch {
				errorData = { message: errorText }
			}
			throw new Error(errorData.message || `API Error: ${response.status} ${response.statusText}`)
		}

		if (response.status === 204 || response.headers.get('content-length') === '0') {
			return null
		}

		const result = await response.json()
		// Legacy API wraps responses in { meta: {...}, data: [...] }
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

		const options = {
			method,
			headers: {
				'Authorization': `Bearer ${this.config.apiKey}`,
				'Content-Type': 'application/json',
			},
		}

		if (!this.config.sslverify) {
			// @ts-ignore - Node 18+ supports this
			options.agent = new (await import('https')).Agent({
				rejectUnauthorized: false,
			})
		}

		if (body) {
			options.body = JSON.stringify(body)
		}

		const response = await fetch(url, options)

		if (!response.ok) {
			const errorText = await response.text()
			let errorData
			try {
				errorData = JSON.parse(errorText)
			} catch {
				errorData = { message: errorText }
			}
			throw new Error(errorData.message || `API Error: ${response.status} ${response.statusText}`)
		}

		if (response.status === 204 || response.headers.get('content-length') === '0') {
			return null
		}

		return await response.json()
	}

	/**
	 * Get or discover the site UUID
	 * @returns {Promise<string>}
	 */
	async getSiteUuid() {
		if (this.siteUuid) {
			return this.siteUuid
		}

		if (this.config.siteUuid) {
			this.siteUuid = this.config.siteUuid
			return this.siteUuid
		}

		// Discover site UUID from site name
		try {
			const siteName = this.config.site || 'default'
			const filter = `internalReference.eq('${siteName}')`
			const response = await this.apiRequest('GET', `/v1/sites?filter=${encodeURIComponent(filter)}`)

			if (response.data && response.data.length > 0) {
				this.siteUuid = response.data[0].id
				this.log('info', `Discovered site UUID: ${this.siteUuid} for site: ${siteName}`)
				return this.siteUuid
			}

			throw new Error(`Site '${siteName}' not found`)
		} catch (e) {
			this.log('error', `Failed to discover site UUID: ${e?.message ?? e}`)
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
			return this.deviceMacToUuid.get(macAddress)
		}

		// Refresh device list
		await this.refreshDeviceList()

		if (this.deviceMacToUuid.has(macAddress)) {
			return this.deviceMacToUuid.get(macAddress)
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
			this.log('warn', `Failed to refresh device list: ${e?.message ?? e}`)
		}
	}

	async #refreshActionInfo() {
		try {
			const siteUuid = await this.getSiteUuid()
			const response = await this.apiRequest('GET', `/v1/sites/${siteUuid}/devices?limit=200`)

			if (response.data) {
				this.switchMacAddressOptions = response.data
					.filter((device) => device.features && device.features.includes('switching'))
					.map((device) => ({
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
			this.log('warn', `Failed to load device list: ${e?.message ?? e}`)
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
			this.log('warn', `Failed to load port profiles: ${e?.message ?? e}`)
			this.portProfileOptions = []
		}

		this.setActionDefinitions(getActionDefinitions(this))
	}

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
			this.log('error', `Connection failed: ${e?.message ?? e}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, e?.message)
		}
	}

	async destroy() {
		if (this.connectionCheckTimer) {
			clearInterval(this.connectionCheckTimer)
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
			const selectedPort = portOverrides.find((port) => port.port_idx == port_idx)
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

			const profileConfig = portProfiles.find((profile) => profile.name == profile_name)
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

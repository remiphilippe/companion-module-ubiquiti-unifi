// @ts-check
/* global fetch */

import { InstanceBase, InstanceStatus, runEntrypoint } from '@companion-module/base'
import pQueue from 'p-queue'
import https from 'https'
import { getActionDefinitions } from './actions.js'
import { getConfigFields } from './config.js'
import { UpgradeScripts } from './upgrades.js'
import { getFeedbackDefinitions } from './feedbacks.js'

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

	/**
	 * Cache of legacy device id (_id) keyed by MAC
	 * @type {Map<string, string>}
	 */
	legacyMacToId = new Map()

	/**
	 * Cache of per-port state keyed by `${mac}:${port}`
	 * Value shape: { linkUp: boolean, poePower: boolean, poeMode?: string }
	 * @type {Map<string, { linkUp: boolean, poePower: boolean, poeMode?: string } >}
	 */
	portStateCache = new Map()

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
		this.setFeedbackDefinitions(getFeedbackDefinitions(this))

		await this.configUpdated(config)

		this.connectionCheckTimer = setInterval(async () => {
			if (this.config.apiKey) {
				try {
					await this.apiRequest('GET', '/v1/info')
					// Also refresh port states periodically
					await this.refreshPortStates()
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
	 * Refresh cached port states from legacy API `/stat/device`
	 */
	async refreshPortStates() {
		try {
			const devices = await this.legacyApiRequest('GET', `/s/<SITE>/stat/device`)
			if (!devices || !Array.isArray(devices)) return
			for (const d of devices) {
				const mac = String(d?.mac || '').toLowerCase()
				const ports = Array.isArray(d?.port_table) ? d.port_table : []
				for (const p of ports) {
					const idx = Number(p?.port_idx ?? p?.portidx ?? p?.port)
					if (!mac || !idx) continue
					const key = `${mac}:${idx}`
					const linkUp = Boolean(p?.up)
					const poePowerVal = p?.poe_power
					const poePower = typeof poePowerVal === 'number' ? poePowerVal > 0 : Boolean(p?.poe_enable || p?.poe)
					const poeMode = p?.poe_mode
					this.portStateCache.set(key, { linkUp, poePower, poeMode })
				}
			}
			// Notify Companion that feedbacks may need to update
			this.checkFeedbacks('PortLinkStatus')
			this.checkFeedbacks('PortPowerStatus')
		} catch (e) {
			const err = /** @type {Error} */ (e)
			this.log('warn', `Failed to refresh port states: ${err?.message ?? err}`)
		}
	}

	/**
	 * Make a legacy API request (for port configuration)
	 * @param {string} method
	 * @param {string} path
	 * @param {any} [body]
	 * @returns {Promise<any>}
	 */
	async legacyApiRequest(method, path, body = null, opts = /** @type {{ suppressNotFound?: boolean }} */ ({})) {
		if (!this.config.apiKey) {
			throw new Error('API Key not configured')
		}

		// Legacy API uses site name, not UUID
		const siteName = this.config.site || 'default'
		const legacyPath = path.replace('<SITE>', siteName)
		// UniFi controller exposes legacy API under /proxy/network/api
		const url = `https://${this.config.host}:${this.config.port}/proxy/network/api${legacyPath}`

		/** @type {any} */
		const options = {
			method,
			headers: {
				'X-API-KEY': this.config.apiKey,
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
		}

		if (!this.config.sslverify) {
			// Ensure TLS verification is disabled for Node fetch
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
			options.agent = getInsecureAgent()
		}

		if (body) {
			options.body = JSON.stringify(body)
		}

		this.debug(`LEGACY REQUEST ${method} ${url}${body ? ` body=${JSON.stringify(body)}` : ''}`)
		let response
		try {
			response = await fetch(url, options)
		} catch (e) {
			const err = /** @type {Error} */ (e)
			const safeHeaders = { ...options.headers }
			if (safeHeaders && typeof safeHeaders === 'object') {
				// Do not leak the API key in logs
				delete safeHeaders.Authorization
			}
			const msg =
				`LEGACY FETCH FAILED ${method} ${url} ` +
				`sslverify=${this.config.sslverify !== false} ` +
				`headers=${JSON.stringify(safeHeaders)} ` +
				`error=${err?.message} ` +
				`name=${err?.name ?? ''} ` +
				`type=${/** @type {any} */ (err)?.type ?? ''} ` +
				`code=${/** @type {any} */ (err)?.code ?? /** @type {any} */ (err)?.cause?.code ?? ''}`
			this.log('error', msg)
			// Always include stack at error level for fetch failures
			if (err && err.stack) {
				this.log('error', String(err.stack))
			}
			throw err
		}
		this.debug(`LEGACY RESPONSE ${method} ${url} status=${response.status}`)

		if (!response.ok) {
			// Some controllers return 404 for unsupported GET on /rest/device/{id}.
			// Allow callers to suppress logging and treat as empty result.
			if (response.status === 404 && opts.suppressNotFound) {
				return Array.isArray(body) ? [] : null
			}
			const errorText = await response.text()
			let errorData
			try {
				errorData = JSON.parse(errorText)
			} catch {
				errorData = { message: errorText }
			}
			const legacyBodySnippet = String(errorText).slice(0, 500)
			this.log(
				'error',
				'LEGACY API ERROR ' +
					method +
					' ' +
					url +
					' ' +
					' status=' +
					response.status +
					' ' +
					response.statusText +
					' body=' +
					legacyBodySnippet
			)
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

		// Integration API is under /proxy/network/integration
		const url = `https://${this.config.host}:${this.config.port}/proxy/network/integration${path}`

		/** @type {any} */
		const options = {
			method,
			headers: {
				'X-API-KEY': this.config.apiKey,
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
		}

		if (!this.config.sslverify) {
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
			options.agent = getInsecureAgent()
		}

		if (body) {
			options.body = JSON.stringify(body)
		}

		this.debug(`API REQUEST ${method} ${url}${body ? ` body=${JSON.stringify(body)}` : ''}`)
		let response
		try {
			response = await fetch(url, options)
		} catch (e) {
			const err = /** @type {Error} */ (e)
			const safeHeaders = { ...options.headers }
			if (safeHeaders && typeof safeHeaders === 'object') {
				delete safeHeaders.Authorization
			}
			const msg =
				`API FETCH FAILED ${method} ${url} ` +
				`sslverify=${this.config.sslverify !== false} ` +
				`headers=${JSON.stringify(safeHeaders)} ` +
				`error=${err?.message} ` +
				`name=${err?.name ?? ''} ` +
				`type=${/** @type {any} */ (err)?.type ?? ''} ` +
				`code=${/** @type {any} */ (err)?.code ?? /** @type {any} */ (err)?.cause?.code ?? ''}`
			this.log('error', msg)
			// Always include stack at error level for fetch failures
			if (err && err.stack) {
				this.log('error', String(err.stack))
			}
			throw err
		}
		this.debug(`API RESPONSE ${method} ${url} status=${response.status}`)

		if (!response.ok) {
			const errorText = await response.text()
			let errorData
			try {
				errorData = JSON.parse(errorText)
			} catch {
				errorData = { message: errorText }
			}
			const bodySnippet = String(errorText).slice(0, 500)
			this.log(
				'error',
				'API ERROR ' +
					method +
					' ' +
					url +
					' ' +
					' status=' +
					response.status +
					' ' +
					response.statusText +
					' body=' +
					bodySnippet
			)
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
		this.setFeedbackDefinitions(getFeedbackDefinitions(this))
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
		this.portStateCache.clear()

		// Test connection and load initial data
		try {
			await this.apiRequest('GET', '/v1/info')
			await this.#refreshActionInfo()
			await this.refreshPortStates()
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
	 * Toggle POE mode between 'auto' and 'off' for a port
	 * @param {string} switch_mac
	 * @param {number} port_idx
	 */
	async togglePortPOEAuto(switch_mac, port_idx) {
		const key = `${String(switch_mac).toLowerCase()}:${Number(port_idx)}`
		const current = this.portStateCache.get(key)
		const currentMode = current?.poeMode || ''
		const nextMode = currentMode === 'auto' ? 'off' : 'auto'
		await this.changePortPOEMode(switch_mac, port_idx, nextMode)
	}

	/**
	 * Toggle POE mode between 'pasv24' and 'off' for a port
	 * @param {string} switch_mac
	 * @param {number} port_idx
	 */
	async togglePortPOEPassive(switch_mac, port_idx) {
		const key = `${String(switch_mac).toLowerCase()}:${Number(port_idx)}`
		const current = this.portStateCache.get(key)
		const currentMode = current?.poeMode || ''
		const nextMode = currentMode === 'pasv24' ? 'off' : 'pasv24'
		await this.changePortPOEMode(switch_mac, port_idx, nextMode)
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

			// First, get the device details from Integration API to get device MAC
			const device = await this.apiRequest('GET', `/v1/sites/${siteUuid}/devices/${deviceUuid}`)

			// Resolve legacy _id by MAC with caching
			const targetMac = String(device.macAddress || device.mac || switch_mac).toLowerCase()
			let deviceId = this.legacyMacToId.get(targetMac) || ''
			if (!deviceId) {
				const legacyDevices = await this.legacyApiRequest('GET', `/s/<SITE>/stat/device`)
				if (!legacyDevices || !Array.isArray(legacyDevices) || legacyDevices.length === 0) {
					throw new Error('Legacy device list not found')
				}
				for (const d of legacyDevices) {
					if (d && d.mac && d._id) {
						this.legacyMacToId.set(String(d.mac).toLowerCase(), String(d._id))
					}
				}
				deviceId = this.legacyMacToId.get(targetMac) || ''
				if (!deviceId) {
					throw new Error(`Device with MAC ${targetMac} not found in legacy API`)
				}
			}

			// Preserve existing port_overrides: try GET /rest/device/{id}, else fallback to /stat/device
			let portOverrides = []
			try {
				const fullDeviceConfig = await this.legacyApiRequest('GET', `/s/<SITE>/rest/device/${deviceId}`, null, {
					suppressNotFound: true,
				})
				const currentDevice = Array.isArray(fullDeviceConfig) ? fullDeviceConfig[0] : fullDeviceConfig
				portOverrides = currentDevice && Array.isArray(currentDevice.port_overrides) ? currentDevice.port_overrides : []
			} catch (e) {
				// ignore, fallback below
			}
			if (!Array.isArray(portOverrides)) portOverrides = []
			if (portOverrides.length === 0) {
				try {
					const legacyDevicesForOverrides = await this.legacyApiRequest('GET', `/s/<SITE>/stat/device`)
					const statDevice = Array.isArray(legacyDevicesForOverrides)
						? legacyDevicesForOverrides.find((d) => String(d?.mac || '').toLowerCase() === targetMac)
						: null
					portOverrides = statDevice && Array.isArray(statDevice.port_overrides) ? statDevice.port_overrides : []
				} catch (e2) {
					portOverrides = []
				}
			}

			// Find or create port override
			const selectedPort = portOverrides.find((/** @type {any} */ port) => port.port_idx == port_idx)
			if (selectedPort) {
				selectedPort.poe_mode = poe_mode
			} else {
				portOverrides.push({ port_idx: Number(port_idx), poe_mode })
			}

			// Update device via legacy API
			await this.legacyApiRequest('PUT', `/s/<SITE>/rest/device/${deviceId}`, { port_overrides: portOverrides })

			// Refresh cached port states to reflect changes sooner
			await this.refreshPortStates()

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

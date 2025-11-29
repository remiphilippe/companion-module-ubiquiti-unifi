// @ts-check

import { Regex } from '@companion-module/base'

/**
 * @returns {import("@companion-module/base").SomeCompanionConfigField[]}
 */
export function getConfigFields() {
	return [
		{
			type: 'static-text',
			id: 'info',
			width: 12,
			label: 'Information',
			value: 'This module will control network switches via a UniFi controller.',
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'Target IP/Host',
			width: 12,
			required: true,
		},
		{
			type: 'textinput',
			id: 'port',
			label: 'Target Port',
			width: 6,
			regex: Regex.PORT,
			default: '8443',
			required: true,
		},
		{
			type: 'checkbox',
			label: 'SSL Verify',
			id: 'sslverify',
			default: false,
			width: 6,
		},
		{
			type: 'static-text',
			id: 'info',
			width: 12,
			label: 'API Key Authentication',
			value:
				'Generate an API Key in the UniFi Network application under Settings → Admins & Users → API Access.<br>The API Key will be stored in clear text within the Companion config.',
		},
		{
			type: 'textinput',
			id: 'apiKey',
			label: 'API Key',
			width: 12,
			required: true,
		},
		{
			type: 'textinput',
			label: 'Site Name',
			id: 'site',
			default: 'default',
			width: 6,
			required: true,
		},
		{
			type: 'textinput',
			label: 'Site UUID (optional)',
			id: 'siteUuid',
			width: 6,
			required: false,
			tooltip: 'Leave empty to auto-discover from site name',
		},
		{
			type: 'checkbox',
			label: 'Verbose Logging',
			id: 'verbose',
			default: false,
			width: 6,
			tooltip: 'When enabled, logs request/response details for debugging',
		},
	]
}

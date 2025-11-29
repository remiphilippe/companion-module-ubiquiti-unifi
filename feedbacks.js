// @ts-check

import { combineRgb } from '@companion-module/base'

/**
 * @param {import('./main.js').UnifiInstance} self
 * @returns {import('@companion-module/base').CompanionFeedbackDefinitions}
 */
export function getFeedbackDefinitions(self) {
	return {
		PortLinkStatus: {
			name: 'Switchport: Link Status',
			type: 'boolean',
			description: 'Change style when port link matches target',
			options: [
				{
					id: 'mac',
					type: 'dropdown',
					label: 'Switch Mac Address',
					choices: self.switchMacAddressOptions,
					allowCustom: true,
					default: '',
				},
				{
					id: 'port',
					type: 'number',
					label: 'Port',
					default: 1,
					min: 1,
					max: 100,
				},
				{
					id: 'state',
					type: 'dropdown',
					label: 'State',
					choices: [
						{ id: 'up', label: 'Up' },
						{ id: 'down', label: 'Down' },
					],
					default: 'up',
				},
			],
			defaultStyle: {
				bgcolor: combineRgb(0, 255, 0),
				color: combineRgb(0, 0, 0),
			},
			callback: (fb) => {
				const mac = String(fb.options.mac || '')
				const port = Number(fb.options.port || 0)
				const target = String(fb.options.state || 'up')
				if (!mac || !port) return false
				const key = `${mac}:${port}`
				const info = self.portStateCache.get(key)
				if (!info) return false
				const isUp = !!info.linkUp
				return (target === 'up' && isUp) || (target === 'down' && !isUp)
			},
		},

		PortPowerStatus: {
			name: 'Switchport: Power (PoE) Status',
			type: 'boolean',
			description: 'Change style when port PoE power matches target',
			options: [
				{
					id: 'mac',
					type: 'dropdown',
					label: 'Switch Mac Address',
					choices: self.switchMacAddressOptions,
					allowCustom: true,
					default: '',
				},
				{
					id: 'port',
					type: 'number',
					label: 'Port',
					default: 1,
					min: 1,
					max: 100,
				},
				{
					id: 'state',
					type: 'dropdown',
					label: 'State',
					choices: [
						{ id: 'on', label: 'On' },
						{ id: 'off', label: 'Off' },
					],
					default: 'on',
				},
			],
			defaultStyle: {
				bgcolor: combineRgb(255, 200, 0),
				color: combineRgb(0, 0, 0),
			},
			callback: (fb) => {
				const mac = String(fb.options.mac || '')
				const port = Number(fb.options.port || 0)
				const target = String(fb.options.state || 'on')
				if (!mac || !port) return false
				const key = `${mac}:${port}`
				const info = self.portStateCache.get(key)
				if (!info) return false
				const poeOn = !!info.poePower
				return (target === 'on' && poeOn) || (target === 'off' && !poeOn)
			},
		},
	}
}

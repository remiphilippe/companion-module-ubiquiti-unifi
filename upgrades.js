// @ts-check

/**
 * @type {import('@companion-module/base').CompanionStaticUpgradeScript<any>[]}
 */
export const UpgradeScripts = [
	// v1: Add default site
	(context, props) => {
		/**
		 * @type {import('@companion-module/base').CompanionStaticUpgradeResult<any>}
		 */
		const result = {
			updatedActions: [],
			updatedFeedbacks: [],
			updatedConfig: null,
		}

		if (props.config && !props.config.site) {
			result.updatedConfig = props.config
			result.updatedConfig.site = 'default'
		}

		return result
	},
	// v2: Migrate from username/password to API Key
	(context, props) => {
		/**
		 * @type {import('@companion-module/base').CompanionStaticUpgradeResult<any>}
		 */
		const result = {
			updatedActions: [],
			updatedFeedbacks: [],
			updatedConfig: null,
		}

		if (props.config) {
			// If old auth fields exist but no apiKey, clear them and require reconfiguration
			if ((props.config.username || props.config.password) && !props.config.apiKey) {
				result.updatedConfig = props.config
				// Remove old authentication fields
				delete result.updatedConfig.username
				delete result.updatedConfig.password
				delete result.updatedConfig.token2FA
				// apiKey will need to be configured by user
			}
		}
		return result
	},
]

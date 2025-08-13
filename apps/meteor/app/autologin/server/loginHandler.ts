import { Users } from '@rocket.chat/models';
import { Accounts } from 'meteor/accounts-base';
import { check } from 'meteor/check';

/**
 * Register login handler for auto-login tokens
 */
Accounts.registerLoginHandler('auto-login', async (options) => {
	// Only handle auto-login attempts
	if (!options.autoLogin) {
		return undefined;
	}

	check(options.autoLogin, String);

	const token = options.autoLogin;

	try {
		// Find user with matching auto-login token
		const user = await Users.findOne({
			'services.autoLogin.token': token,
			'services.autoLogin.expiresAt': { $gt: new Date() },
			'active': true,
		});

		if (!user) {
			return null;
		}

		// Clean up the auto-login token after successful use
		await Users.updateOne({ _id: user._id }, { $unset: { 'services.autoLogin': 1 } });

		return {
			userId: user._id,
		};
	} catch (error) {
		return null;
	}
});

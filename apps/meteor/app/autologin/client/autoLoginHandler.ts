import { Accounts } from 'meteor/accounts-base';
import { Meteor } from 'meteor/meteor';

// Auto-login client handler
Meteor.startup(() => {
	// Check if we have an auto-login token in the URL hash
	if (window.location.hash?.includes('autoLogin=')) {
		try {
			// Extract token from hash
			const hashParams = new URLSearchParams(window.location.hash.substring(1));
			const token = hashParams.get('autoLogin');

			if (token) {
				// Clean up the hash from URL immediately
				window.history.replaceState(null, '', window.location.pathname);

				// Use proper Meteor login method
				Accounts.callLoginMethod({
					methodArguments: [
						{
							autoLogin: token,
						},
					],
					userCallback: (error) => {
						if (error) {
							// Redirect to login page on failure
							window.location.href = '/login';
						} else {
							// Redirect to home on success
							window.location.href = '/home';
						}
					},
				});
			}
		} catch (error) {
			// Clean up hash on error
			window.history.replaceState(null, '', window.location.pathname);
			// Redirect to login page on error
			window.location.href = '/login';
		}
	}
});

import { Users } from '@rocket.chat/models';
import { Accounts } from 'meteor/accounts-base';

// Static token for testing (will be configurable later)
const STATIC_TOKEN = 'GENUSYS_TOKEN';

interface AutoLoginRequest {
	email: string;
	token: string;
}

interface AutoLoginResult {
	success: boolean;
	error?: string;
	userId?: string;
	loginToken?: string;
	user?: {
		username: string;
		name: string;
	};
}

export class AutoLoginService {
	/**
	 * Validate the auto-login request
	 */
	private validateRequest(email: string, token: string): { valid: boolean; error?: string } {
		// Check static token
		if (token !== STATIC_TOKEN) {
			return { valid: false, error: 'Invalid token' };
		}

		// Email is required
		if (!email || typeof email !== 'string' || !email.trim()) {
			return { valid: false, error: 'Email required' };
		}

		// Basic email format validation
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!emailRegex.test(email)) {
			return { valid: false, error: 'Invalid email format' };
		}

		return { valid: true };
	}

	/**
	 * Handle auto-login request
	 */
	async handleAutoLogin(email: string, token: string): Promise<AutoLoginResult> {
		try {
			// 1. Validate request parameters
			const validation = this.validateRequest(email, token);
			if (!validation.valid) {
				return { success: false, error: validation.error };
			}

			// 2. Find user by email
			const user = await Users.findOne({
				'emails.address': email.toLowerCase().trim(),
				'active': true,
			});

			if (!user) {
				return { success: false, error: 'User not authorized' };
			}

			// 3. Create login token using standard Meteor approach
			const loginToken = Accounts._generateStampedLoginToken();

			// Insert the token using Meteor's standard method
			await Accounts._insertLoginToken(user._id, loginToken);

			// Store the token temporarily for auto-login handler
			await Users.updateOne(
				{ _id: user._id },
				{
					$set: {
						'services.autoLogin': {
							token: loginToken.token,
							createdAt: new Date(),
							// Auto-expire after 5 minutes
							expiresAt: new Date(Date.now() + 5 * 60 * 1000),
						},
					},
				},
			);

			return {
				success: true,
				userId: user._id,
				loginToken: loginToken.token,
				user: {
					username: user.username || '',
					name: user.name || user.username || '',
				},
			};
		} catch (error) {
			return { success: false, error: 'Login failed' };
		}
	}

	/**
	 * Get static token for testing purposes
	 */
	getStaticToken(): string {
		return STATIC_TOKEN;
	}
}

export const autoLoginService = new AutoLoginService();

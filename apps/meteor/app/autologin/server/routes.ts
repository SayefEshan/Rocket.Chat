import url from 'url';

import { WebApp } from 'meteor/webapp';

import { autoLoginService } from './service';

/**
 * Render error page for unauthorized access
 */
function renderErrorPage(res: any, message: string): void {
	const errorHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Access Denied - Rocket.Chat</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            margin: 0;
            padding: 0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .error-container {
            background: white;
            padding: 2rem;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            text-align: center;
            max-width: 400px;
            width: 90%;
        }
        .error-icon {
            font-size: 3rem;
            margin-bottom: 1rem;
            color: #f5455c;
        }
        h1 {
            color: #2f343d;
            margin: 0 0 1rem 0;
            font-size: 1.5rem;
        }
        p {
            color: #6c737a;
            margin: 0 0 1.5rem 0;
            line-height: 1.5;
        }
        .btn-home {
            background: #1d74f5;
            color: white;
            padding: 0.75rem 1.5rem;
            border: none;
            border-radius: 4px;
            text-decoration: none;
            display: inline-block;
            transition: background 0.2s;
        }
        .btn-home:hover {
            background: #175cc4;
        }
    </style>
</head>
<body>
    <div class="error-container">
        <div class="error-icon">🚫</div>
        <h1>Access Denied</h1>
        <p>${message}</p>
        <a href="/" class="btn-home">Go to Home</a>
    </div>
</body>
</html>`;

	res.writeHead(401, {
		'Content-Type': 'text/html',
		'Cache-Control': 'no-cache, no-store, must-revalidate',
		'Pragma': 'no-cache',
		'Expires': '0',
	});
	res.end(errorHtml);
}

/**
 * Auto-login route handler
 */
WebApp.connectHandlers.use('/autologin', async (req: any, res: any, next: any) => {
	try {
		// Only handle GET requests
		if (req.method !== 'GET') {
			return next();
		}

		// Parse query parameters
		const parsedUrl = url.parse(req.url || '', true);
		const { email, token } = parsedUrl.query;

		// Validate parameters
		if (!email || !token) {
			return renderErrorPage(res, 'Missing required parameters: email and token');
		}

		// Handle auto-login
		const result = await autoLoginService.handleAutoLogin(String(email), String(token));

		if (!result.success) {
			return renderErrorPage(res, result.error || 'Authorization failed');
		}

		// Use redirect with token in URL hash for client processing
		// This avoids CSP issues with inline scripts
		const redirectUrl = `/home#autoLogin=${result.loginToken}`;

		res.writeHead(302, {
			'Location': redirectUrl,
			'Cache-Control': 'no-cache, no-store, must-revalidate',
			'Pragma': 'no-cache',
			'Expires': '0',
		});
		res.end();
	} catch (error) {
		return renderErrorPage(res, 'An error occurred during login. Please try again.');
	}
});

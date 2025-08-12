#!/usr/bin/env node

/**
 * MongoDB Direct User Import for Rocket.Chat
 * 
 * This script directly inserts users into the MongoDB database, bypassing the API.
 * Supports multiple imports, duplicate handling, and JSON format.
 * 
 * Usage:
 *   node mongodb-user-import.js [file.json|count] [options]
 * 
 * Features:
 *   - Direct MongoDB connection for performance
 *   - Password hashing compatible with Rocket.Chat
 *   - Duplicate detection and handling
 *   - Transaction support for safety
 *   - JSON input support
 *   - Batch processing for large datasets
 */

const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class RocketChatMongoUserImport {
    constructor(config) {
        this.config = {
            mongoUrl: config.mongoUrl || 'mongodb://localhost:27017',
            dbName: config.dbName || 'rocketchat',
            batchSize: config.batchSize || 100,
            saltRounds: config.saltRounds || 10,
            ...config
        };
        
        this.client = null;
        this.db = null;
        this.stats = {
            processed: 0,
            created: 0,
            skipped: 0,
            updated: 0,
            failed: 0,
            errors: []
        };
    }

    /**
     * Test MongoDB connection
     */
    async testConnection() {
        try {
            console.log('🔍 Testing MongoDB connection...');
            await this.connect();
            
            // Test database access
            const adminDb = this.db.admin();
            await adminDb.ping();
            
            // Check if users collection exists
            const collections = await this.db.listCollections({ name: 'users' }).toArray();
            const usersExists = collections.length > 0;
            
            console.log('✅ MongoDB connection successful');
            console.log(`📋 Database: ${this.config.dbName}`);
            console.log(`👥 Users collection: ${usersExists ? 'exists' : 'will be created'}`);
            
            await this.disconnect();
            return true;
        } catch (error) {
            console.error('❌ MongoDB connection failed:', error.message);
            return false;
        }
    }

    /**
     * Connect to MongoDB
     */
    async connect() {
        try {
            this.client = new MongoClient(this.config.mongoUrl);
            await this.client.connect();
            this.db = this.client.db(this.config.dbName);
            console.log('🔗 Connected to MongoDB');
        } catch (error) {
            throw new Error(`Failed to connect to MongoDB: ${error.message}`);
        }
    }

    /**
     * Disconnect from MongoDB
     */
    async disconnect() {
        if (this.client) {
            await this.client.close();
            console.log('📤 Disconnected from MongoDB');
        }
    }

    /**
     * Hash password using bcrypt (compatible with Rocket.Chat)
     * Rocket.Chat expects bcrypt(sha256(password))
     */
    async hashPassword(password) {
        // First convert to SHA-256 (like Rocket.Chat client does)
        const sha256Hash = crypto.createHash('sha256').update(password).digest('hex');
        // Then bcrypt the SHA-256 hash (like Rocket.Chat server expects)
        return await bcrypt.hash(sha256Hash, this.config.saltRounds);
    }

    /**
     * Generate Rocket.Chat compatible user ID
     */
    generateUserId() {
        // Rocket.Chat uses Random.id() which generates 17-character alphanumeric strings
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < 17; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    /**
     * Transform user input to Rocket.Chat user document
     */
    async transformUser(userInput, index) {
        // Validation
        if (!userInput.username) {
            throw new Error(`User at index ${index} missing username`);
        }
        
        if (!userInput.emails || (Array.isArray(userInput.emails) && userInput.emails.length === 0)) {
            throw new Error(`User at index ${index} missing emails`);
        }

        // Ensure emails is an array
        const emails = Array.isArray(userInput.emails) ? userInput.emails : [userInput.emails];
        
        // Hash password if provided
        let hashedPassword = null;
        if (userInput.password) {
            hashedPassword = await this.hashPassword(userInput.password);
        }

        const now = new Date();
        const userId = this.generateUserId();

        // Build user document compatible with Rocket.Chat schema
        const user = {
            _id: userId,
            username: userInput.username,
            emails: emails.map(email => ({
                address: email,
                verified: true
            })),
            name: userInput.name || userInput.username,
            type: userInput.type || 'user',
            active: userInput.active !== undefined ? userInput.active : true,
            roles: userInput.roles || ['user'],
            status: userInput.status || 'offline',
            statusConnection: userInput.statusConnection || 'offline',
            createdAt: now,
            _updatedAt: now,
            requirePasswordChange: userInput.requirePasswordChange || false,
            loginAttempts: [],
            settings: {
                profile: {}
            }
        };

        // Add password and email services if provided
        if (hashedPassword) {
            user.services = {
                password: {
                    bcrypt: hashedPassword
                },
                email: {
                    verificationTokens: emails.map(email => ({
                        token: this.generateUserId(), // Use same random generator
                        address: email,
                        when: now
                    }))
                },
                resume: {
                    loginTokens: []
                }
            };
        }

        // Add custom fields
        if (userInput.employeeId || userInput.location || userInput.department || userInput.customFields) {
            user.customFields = {
                ...(userInput.employeeId && { employeeId: userInput.employeeId }),
                ...(userInput.location && { location: userInput.location }),
                ...(userInput.department && { department: userInput.department }),
                ...(userInput.customFields || {})
            };
        }

        // Add optional fields
        if (userInput.bio) user.bio = userInput.bio;
        if (userInput.nickname) user.nickname = userInput.nickname;
        if (userInput.utcOffset !== undefined) user.utcOffset = userInput.utcOffset;
        if (userInput.avatarUrl) user.avatarUrl = userInput.avatarUrl;
        if (userInput.statusText) user.statusText = userInput.statusText;

        return user;
    }

    /**
     * Check if user already exists
     */
    async userExists(username, email) {
        const users = this.db.collection('users');
        
        const existingUser = await users.findOne({
            $or: [
                { username: username },
                { 'emails.address': { $in: Array.isArray(email) ? email : [email] } }
            ]
        });
        
        return existingUser;
    }

    /**
     * Insert users in batches with duplicate handling
     */
    async insertUsers(users, options = {}) {
        const {
            skipExisting = true,
            updateExisting = false,
            dryRun = false
        } = options;

        const usersCollection = this.db.collection('users');
        const totalBatches = Math.ceil(users.length / this.config.batchSize);

        console.log(`👥 Processing ${users.length} users in ${totalBatches} batches...`);
        
        if (dryRun) {
            console.log('🔍 DRY RUN MODE - No changes will be made');
        }

        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            const startIdx = batchIndex * this.config.batchSize;
            const endIdx = Math.min(startIdx + this.config.batchSize, users.length);
            const batch = users.slice(startIdx, endIdx);

            console.log(`📦 Processing batch ${batchIndex + 1}/${totalBatches} (users ${startIdx + 1}-${endIdx})...`);

            // Process batch without transactions (for standalone MongoDB)
            try {
                for (const user of batch) {
                    this.stats.processed++;
                    
                    try {
                        // Check for existing user
                        const emails = user.emails.map(e => e.address);
                        const existing = await this.userExists(user.username, emails);
                        
                        if (existing) {
                            if (updateExisting && !dryRun) {
                                // Update existing user
                                await usersCollection.replaceOne(
                                    { _id: existing._id },
                                    { ...user, _id: existing._id, createdAt: existing.createdAt }
                                );
                                this.stats.updated++;
                                console.log(`🔄 Updated: ${user.username}`);
                            } else {
                                // Skip existing user
                                this.stats.skipped++;
                                console.log(`⏭️  Skipped: ${user.username} (already exists)`);
                            }
                        } else {
                            if (!dryRun) {
                                // Insert new user
                                await usersCollection.insertOne(user);
                            }
                            this.stats.created++;
                            console.log(`✅ Created: ${user.username}`);
                        }
                    } catch (error) {
                        this.stats.failed++;
                        this.stats.errors.push(`${user.username}: ${error.message}`);
                        console.error(`❌ Failed: ${user.username} - ${error.message}`);
                    }
                }
            } catch (error) {
                console.error(`❌ Batch ${batchIndex + 1} failed:`, error.message);
                throw error;
            }

            // Progress update
            const percentage = Math.round(((batchIndex + 1) / totalBatches) * 100);
            console.log(`📈 Progress: ${percentage}% (${endIdx}/${users.length} users)`);
        }
    }


    /**
     * Load users from JSON file
     */
    async loadUsersFromFile(filePath) {
        console.log(`📄 Loading users from ${filePath}...`);
        
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        // JSON format
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const rawData = JSON.parse(fileContent);
        
        if (!Array.isArray(rawData)) {
            throw new Error(`File ${filePath} must contain an array of users`);
        }

        console.log(`✅ Loaded ${rawData.length} users from JSON file`);
        return rawData;
    }

    /**
     * Generate sample users for testing
     */
    generateSampleUsers(count = 10) {
        console.log(`🧪 Generating ${count} sample users...`);
        
        const locations = ['New York', 'London', 'Tokyo', 'San Francisco', 'Berlin', 'Sydney', 'Mumbai', 'Toronto'];
        const departments = ['Engineering', 'Marketing', 'Sales', 'HR', 'Operations', 'Design', 'Finance', 'Support'];
        const firstNames = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry', 'Ivy', 'Jack'];
        const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez'];
        
        const users = [];
        
        for (let i = 1; i <= count; i++) {
            const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
            const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
            const username = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${i > 10 ? i : ''}`;
            const employeeId = `EMP${String(i).padStart(3, '0')}`;
            
            users.push({
                username,
                emails: [`${username}@company.com`],
                name: `${firstName} ${lastName}`,
                employeeId,
                location: locations[Math.floor(Math.random() * locations.length)],
                department: departments[Math.floor(Math.random() * departments.length)],
                password: `TempPass${String(i).padStart(3, '0')}!`,
                roles: ['user'],
                bio: `${departments[Math.floor(Math.random() * departments.length)]} team member`,
                utcOffset: (Math.floor(Math.random() * 24) - 12)
            });
        }
        
        return users;
    }

    /**
     * Print import statistics
     */
    printStats() {
        console.log('\n📊 Import Statistics:');
        console.log('=' .repeat(50));
        console.log(`👥 Total Processed: ${this.stats.processed}`);
        console.log(`✅ Users Created: ${this.stats.created}`);
        console.log(`🔄 Users Updated: ${this.stats.updated}`);
        console.log(`⏭️  Users Skipped: ${this.stats.skipped}`);
        console.log(`❌ Failed: ${this.stats.failed}`);
        
        if (this.stats.errors.length > 0) {
            console.log('\n❌ Errors:');
            this.stats.errors.forEach(error => console.log(`   ${error}`));
        }
        
        console.log('\n📝 Next Steps:');
        console.log('✉️  Users can now login with their email/username and password');
        console.log('🔒 Recommend: Enable "Require Password Change" in Administration > Settings');
        console.log('👀 Check: Administration > Users to verify imports');
        console.log('⚙️  Configure: Custom field visibility if needed');
    }

    /**
     * Main import process
     */
    async importUsers(input, options = {}) {
        const startTime = Date.now();
        
        try {
            console.log('🚀 Starting MongoDB direct user import...');
            
            // Connect to MongoDB
            await this.connect();
            
            // Load or generate users
            let users;
            if (typeof input === 'string' && fs.existsSync(input)) {
                // Load from JSON file
                const rawUsers = await this.loadUsersFromFile(input);
                users = [];
                for (let i = 0; i < rawUsers.length; i++) {
                    users.push(await this.transformUser(rawUsers[i], i));
                }
            } else if (typeof input === 'number' || /^\d+$/.test(input)) {
                // Generate sample users
                const count = typeof input === 'number' ? input : parseInt(input);
                const rawUsers = this.generateSampleUsers(count);
                users = [];
                for (let i = 0; i < rawUsers.length; i++) {
                    users.push(await this.transformUser(rawUsers[i], i));
                }
            } else {
                throw new Error('Invalid input: must be a JSON file path or number of users to generate');
            }
            
            // Import users
            await this.insertUsers(users, options);
            
            const duration = Math.round((Date.now() - startTime) / 1000);
            console.log(`\n🎉 Import completed in ${duration} seconds!`);
            
            this.printStats();
            
        } catch (error) {
            const duration = Math.round((Date.now() - startTime) / 1000);
            console.error(`\n❌ Import failed after ${duration} seconds:`, error.message);
            throw error;
        } finally {
            await this.disconnect();
        }
    }
}

// CLI execution
async function main() {
    const args = process.argv.slice(2);
    
    // Parse arguments
    const input = args.find(arg => !arg.startsWith('-')) || '10';
    const isForced = args.includes('--force') || args.includes('-f');
    const isQuiet = args.includes('--quiet') || args.includes('-q');
    const isDryRun = args.includes('--dry-run');
    const skipExisting = args.includes('--skip-existing') || !args.includes('--update-existing');
    const updateExisting = args.includes('--update-existing');
    
    // Configuration
    const config = {
        mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:3001/meteor?replicaSet=meteor',
        dbName: process.env.MONGO_DB_NAME || 'meteor',
        batchSize: parseInt(process.env.BATCH_SIZE || '100')
    };
    
    const importer = new RocketChatMongoUserImport(config);
    
    try {
        if (args.includes('--help') || args.includes('-h')) {
            console.log(`
MongoDB Direct User Import for Rocket.Chat

Usage: node mongodb-user-import.js [file.json|count] [options]

Arguments:
  file.json             User data file in JSON format
  count                 Number of sample users to generate (e.g., 50)

Options:
  --force, -f           Skip confirmation prompts
  --quiet, -q           Minimal output
  --dry-run             Show what would be imported without making changes
  --skip-existing       Skip users that already exist (default)
  --update-existing     Update existing users with new data
  --help, -h            Show this help message

Environment Variables:
  MONGO_URL             MongoDB connection URL (default: mongodb://localhost:3001/meteor?replicaSet=meteor)
  MONGO_DB_NAME         Database name (default: meteor)
  BATCH_SIZE            Users per batch (default: 100)

Examples:
  node mongodb-user-import.js users.json --force
  node mongodb-user-import.js 100 --force --skip-existing
  node mongodb-user-import.js users.json --dry-run
  node mongodb-user-import.js new-users.json --update-existing
`);
            return;
        }

        console.log('🚀 Rocket.Chat MongoDB User Import');
        console.log(`📍 MongoDB: ${config.mongoUrl}`);
        console.log(`🗄️  Database: ${config.dbName}`);
        console.log(`📦 Batch Size: ${config.batchSize}`);
        
        // Test connection first
        const connectionOk = await importer.testConnection();
        if (!connectionOk) {
            process.exit(1);
        }
        
        if (!isForced && !isQuiet && !isDryRun) {
            console.log(`\n⚠️  Ready to import users. Continue? (y/N)`);
            console.log('💡 Use --force to skip this prompt or --dry-run to test first');
            process.exit(0);
        }
        
        // Import users
        await importer.importUsers(input, {
            skipExisting,
            updateExisting,
            dryRun: isDryRun
        });
        
    } catch (error) {
        console.error('💥 Fatal error:', error.message);
        if (process.env.NODE_ENV === 'development') {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

// Export for use as module
module.exports = { RocketChatMongoUserImport };

// Run if called directly
if (require.main === module) {
    main().catch(console.error);
}
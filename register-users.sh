#!/bin/bash

# Rocket.Chat MongoDB Direct User Import Script
# Usage: ./register-users.sh [users.json|count] [options]

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default configuration
MONGO_URL=${MONGO_URL:-"mongodb://localhost:3001/meteor?replicaSet=meteor"}
MONGO_DB_NAME=${MONGO_DB_NAME:-"meteor"}
BATCH_SIZE=${BATCH_SIZE:-"100"}

echo -e "${BLUE}🚀 Rocket.Chat MongoDB User Import${NC}"
echo -e "${BLUE}=====================================${NC}"
echo ""
echo -e "🗄️  MongoDB: ${MONGO_URL}"
echo -e "📊 Database: ${MONGO_DB_NAME}"
echo -e "📦 Batch Size: ${BATCH_SIZE}"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Error: Node.js is not installed${NC}"
    echo "Please install Node.js 16+ from https://nodejs.org/"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 16 ]; then
    echo -e "${RED}❌ Error: Node.js version $NODE_VERSION is too old${NC}"
    echo "Please upgrade to Node.js 16 or higher"
    exit 1
fi

echo -e "${GREEN}✅ Node.js $(node -v) detected${NC}"

# Check MongoDB connectivity
echo -e "${YELLOW}🔍 Checking MongoDB connectivity...${NC}"
if ! node -e "
const { MongoClient } = require('mongodb');
(async () => {
    try {
        const client = new MongoClient('${MONGO_URL}');
        await client.connect();
        await client.db('${MONGO_DB_NAME}').admin().ping();
        await client.close();
        console.log('MongoDB connection successful');
        process.exit(0);
    } catch (error) {
        console.error('MongoDB connection failed:', error.message);
        process.exit(1);
    }
})();
" 2>/dev/null; then
    echo -e "${RED}❌ Error: Cannot connect to MongoDB at ${MONGO_URL}${NC}"
    echo "Please ensure:"
    echo "  - MongoDB server is running"
    echo "  - Connection URL is correct"
    echo "  - Database '${MONGO_DB_NAME}' is accessible"
    echo "  - Install dependencies: npm install --prefix . -f bulk-registration-package.json"
    exit 1
fi

echo -e "${GREEN}✅ MongoDB is accessible${NC}"

# Check if required files exist
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONGO_SCRIPT="${SCRIPT_DIR}/mongodb-user-import.js"
PACKAGE_FILE="${SCRIPT_DIR}/bulk-registration-package.json"

if [ ! -f "$MONGO_SCRIPT" ]; then
    echo -e "${RED}❌ Error: MongoDB import script not found${NC}"
    echo "Expected file: ${MONGO_SCRIPT}"
    exit 1
fi

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}📦 Installing dependencies...${NC}"
    if [ -f "$PACKAGE_FILE" ]; then
        npm install --package-lock-only --package-lock=false mongodb bcrypt csv-parse uuid 2>/dev/null || {
            echo -e "${RED}❌ Failed to install dependencies${NC}"
            echo "Run manually: npm install mongodb bcrypt csv-parse uuid"
            exit 1
        }
        echo -e "${GREEN}✅ Dependencies installed${NC}"
    else
        echo -e "${YELLOW}⚠️  Installing basic dependencies...${NC}"
        npm install mongodb bcrypt csv-parse uuid 2>/dev/null || {
            echo -e "${RED}❌ Failed to install dependencies${NC}"
            exit 1
        }
    fi
fi

echo -e "${GREEN}✅ MongoDB import script ready${NC}"

# Parse arguments
USER_FILE=""
FORCE_FLAG=""
QUIET_FLAG=""
DRY_RUN_FLAG=""
SKIP_EXISTING_FLAG=""
UPDATE_EXISTING_FLAG=""

for arg in "$@"; do
    case $arg in
        --force|-f)
            FORCE_FLAG="--force"
            ;;
        --quiet|-q)
            QUIET_FLAG="--quiet"
            ;;
        --dry-run)
            DRY_RUN_FLAG="--dry-run"
            ;;
        --skip-existing)
            SKIP_EXISTING_FLAG="--skip-existing"
            ;;
        --update-existing)
            UPDATE_EXISTING_FLAG="--update-existing"
            ;;
        --help|-h)
            echo "Usage: $0 [users.json|count] [options]"
            echo ""
            echo "Arguments:"
            echo "  users.json              User data file in JSON format"
            echo "  count                   Number of sample users to generate (e.g., 50)"
            echo ""
            echo "Options:"
            echo "  --force, -f             Skip confirmation prompts"
            echo "  --quiet, -q             Minimal output"
            echo "  --dry-run               Show what would be imported without making changes"
            echo "  --skip-existing         Skip users that already exist (default)"
            echo "  --update-existing       Update existing users with new data"
            echo "  --help, -h              Show this help message"
            echo ""
            echo "Environment Variables:"
            echo "  MONGO_URL               MongoDB connection URL (default: mongodb://localhost:3001/meteor?replicaSet=meteor)"
            echo "  MONGO_DB_NAME           Database name (default: meteor)"
            echo "  BATCH_SIZE              Users per batch (default: 100)"
            echo ""
            echo "Examples:"
            echo "  $0 users.json --force                    Import users from JSON file"
            echo "  $0 100 --force --skip-existing           Generate and import 100 sample users"
            echo "  $0 users.json --dry-run                  Test import without making changes"
            echo "  $0 new-users.json --update-existing      Update existing users"
            echo "  $0 --help                                Show this help"
            exit 0
            ;;
        -*)
            echo -e "${YELLOW}⚠️  Unknown option: $arg${NC}"
            ;;
        *)
            if [ -z "$USER_FILE" ]; then
                USER_FILE="$arg"
            fi
            ;;
    esac
done

# Validate user file or count
if [ -n "$USER_FILE" ]; then
    if [ -f "$USER_FILE" ]; then
        echo -e "${GREEN}✅ Using user file: ${USER_FILE}${NC}"
    elif [[ "$USER_FILE" =~ ^[0-9]+$ ]]; then
        echo -e "${GREEN}✅ Generating ${USER_FILE} sample users${NC}"
    else
        echo -e "${RED}❌ Error: Invalid input '${USER_FILE}'${NC}"
        echo "Expected: JSON file path or number of users"
        exit 1
    fi
else
    USER_FILE="10"
    echo -e "${YELLOW}⚠️  No input specified, using default: 10 sample users${NC}"
fi

# Confirmation prompt (unless forced, quiet, or dry-run)
if [ -z "$FORCE_FLAG" ] && [ -z "$QUIET_FLAG" ] && [ -z "$DRY_RUN_FLAG" ]; then
    echo ""
    echo -e "${YELLOW}⚠️  Ready to import users. Continue? (y/N)${NC}"
    echo -e "${BLUE}💡 Use --force to skip this prompt or --dry-run to test first${NC}"
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        echo -e "${BLUE}ℹ️  Import cancelled${NC}"
        exit 0
    fi
fi

# Execute the import
echo ""
echo -e "${BLUE}🚀 Starting MongoDB user import...${NC}"
echo ""

# Export environment variables for the child process
export MONGO_URL
export MONGO_DB_NAME
export BATCH_SIZE

# Build command arguments
ARGS="$USER_FILE"
[ -n "$FORCE_FLAG" ] && ARGS="$ARGS $FORCE_FLAG"
[ -n "$QUIET_FLAG" ] && ARGS="$ARGS $QUIET_FLAG"
[ -n "$DRY_RUN_FLAG" ] && ARGS="$ARGS $DRY_RUN_FLAG"
[ -n "$SKIP_EXISTING_FLAG" ] && ARGS="$ARGS $SKIP_EXISTING_FLAG"
[ -n "$UPDATE_EXISTING_FLAG" ] && ARGS="$ARGS $UPDATE_EXISTING_FLAG"

# Run MongoDB import script
node "$MONGO_SCRIPT" $ARGS

# Check exit code
if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}🎉 MongoDB user import completed successfully!${NC}"
    echo ""
    echo -e "${BLUE}📋 Next Steps:${NC}"
    echo -e "  1. 👥 Verify users in Administration > Users"
    echo -e "  2. 🔐 Configure password policies in Administration > Settings > Accounts"
    echo -e "  3. 📧 Consider sending welcome emails to new users"
    echo -e "  4. ⚙️  Configure custom field visibility if needed"
    echo -e "  5. 🔑 Users can login with their username/email and password"
else
    echo ""
    echo -e "${RED}❌ Import failed. Check the output above for details.${NC}"
    exit 1
fi
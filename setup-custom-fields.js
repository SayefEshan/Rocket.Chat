// Script to set up custom user fields in Rocket.Chat
// This script should be run in the Rocket.Chat MongoDB database

// Connect to your MongoDB instance and run this script
// Example: mongo localhost:3001/rocketchat setup-custom-fields.js

// The custom fields configuration for Accounts_CustomFields setting
const customFieldsConfig = JSON.stringify({
  location: {
    type: 'text',
    required: false,
    defaultValue: '',
    modifyRecordOnEdit: false,
    public: true,
    private: false,
    options: '',
    loginField: false,
    inRegistration: false
  },
  employeeId: {
    type: 'text',
    required: false,
    defaultValue: '',
    modifyRecordOnEdit: false,
    public: true,
    private: false,
    options: '',
    loginField: false,
    inRegistration: false
  }
});

// Update the Accounts_CustomFields setting
db.rocketchat_settings.updateOne(
  { _id: 'Accounts_CustomFields' },
  {
    $set: {
      value: customFieldsConfig,
      ts: new Date(),
      _updatedAt: new Date()
    }
  },
  { upsert: true }
);

print('Custom fields configuration has been updated successfully!');
print('The following fields have been added:');
print('1. location - Text field for user location');
print('2. employeeId - Text field for employee ID');
print('');
print('You may need to restart your Rocket.Chat server for changes to take effect.');

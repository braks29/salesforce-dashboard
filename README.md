# Salesforce Dashboard

A modern, responsive dashboard for visualizing Salesforce opportunities with two specialized views:

- **Bi-Week View**: "What did we create this week?" - Shows opportunities grouped by creation day (Mon/Tue/Wed)
- **Five-Yard View**: "How close are we to wiring money?" - Shows opportunities by sales stage (Engaged/Five-Yard/Closed-Won)

## Features

### 🎯 Two Specialized Views
- **Bi-Week View**: Track newly created opportunities by day of the week
- **Five-Yard View**: Monitor opportunities by proximity to closing

### 🔍 Follow-up Surfacing
Cards needing follow-up are visually flagged with:
- Yellow border and clock icon
- Follow-up reason indicator

**Follow-up Detection Methods:**
1. **Preferred**: Explicit Salesforce fields (Next Action Date, Next Step, overdue Tasks)
2. **Fallback**: NLP scan of latest Notes for phrases like "follow up next week"

### 🎨 Modern Interface
- Responsive design that works on desktop and mobile
- Kanban-style card layout
- Interactive modals with detailed opportunity information
- Real-time filtering by intent
- Keyboard shortcuts (Ctrl+1 for Bi-Week, Ctrl+2 for Five-Yard)

### 🔗 Salesforce Integration
- Secure authentication using JSForce
- Real-time data fetching
- Support for custom fields and relationships

## Quick Start

### Prerequisites
- Node.js (v14 or higher)
- Salesforce account with API access
- Salesforce Security Token

### Installation

1. **Clone and setup the project:**
   ```bash
   git clone <repository-url>
   cd salesforce-dashboard
   npm install
   ```

2. **Configure environment variables:**
   Copy the `.env` file and update with your Salesforce credentials:
   ```env
   SALESFORCE_USERNAME=your-username@domain.com
   SALESFORCE_PASSWORD=your-password
   SALESFORCE_SECURITY_TOKEN=your-security-token
   SALESFORCE_LOGIN_URL=https://login.salesforce.com
   SALESFORCE_API_VERSION=58.0
   PORT=3000
   ```

3. **Start the application:**
   ```bash
   npm start
   ```

4. **Open your browser:**
   Navigate to `http://localhost:3000`

## Configuration

### Salesforce Setup

1. **Get your Security Token:**
   - Go to Salesforce Setup → Personal Setup → My Personal Information → Reset My Security Token
   - Click "Reset Security Token" - you'll receive it via email

2. **API Access:**
   - Ensure your Salesforce user has API access enabled
   - Verify you can access Opportunity, Account, Task, and Note objects

3. **Custom Fields (Optional):**
   The dashboard looks for these fields to enhance follow-up detection:
   - `Next_Action_Date__c`
   - `Next_Step__c` (standard field)
   - Related Tasks and Notes

### Intent Filtering

The dashboard supports filtering opportunities by "intent" keywords. You can customize the intent options by modifying the dropdown in [`public/index.html`](public/index.html:39).

Current intent filters:
- Software
- Consulting  
- Training
- Support

## Usage

### View Navigation
- **Bi-Week View**: Click the calendar icon or press `Ctrl+1`
- **Five-Yard View**: Click the target icon or press `Ctrl+2`

### Filtering
- Use the Intent dropdown to filter opportunities by type
- Click Refresh to reload data from Salesforce

### Card Interactions
- Click any opportunity card to view detailed information
- Cards with follow-up needs show a yellow border and clock icon
- Press `Escape` to close modal windows

### Follow-up Indicators

Cards are flagged for follow-up based on:

1. **Explicit Fields** (Preferred):
   - Next Step date has passed
   - Open Tasks with overdue dates

2. **NLP Analysis** (Fallback):
   - Notes containing phrases like:
     - "follow up next week"
     - "call back"
     - "need to follow up"
     - "follow up required"

## API Endpoints

### GET `/api/opportunities`
Fetch opportunities for dashboard views.

**Parameters:**
- `view`: `biweek` or `fiveyard`
- `intent`: Optional intent filter

**Response:**
```json
[
  {
    "id": "0061234567890ABC",
    "name": "Acme Corp - Software License",
    "stage": "Proposal/Price Quote",
    "amount": 50000,
    "closeDate": "2024-01-15",
    "accountName": "Acme Corp",
    "ownerName": "John Doe",
    "needsFollowUp": true,
    "followUpReason": "Next step date passed",
    "tasks": [...],
    "latestNote": {...}
  }
]
```

### GET `/api/health`
Health check endpoint.

## Project Structure

```
salesforce-dashboard/
├── server.js              # Express server with Salesforce integration
├── package.json           # Dependencies and scripts
├── .env                   # Environment configuration (not in repo)
├── .gitignore            # Git ignore rules
├── README.md             # This file
└── public/               # Frontend assets
    ├── index.html        # Main dashboard HTML
    ├── styles.css        # Dashboard styling
    └── dashboard.js      # Frontend JavaScript logic
```

## Development

### Running in Development Mode
```bash
npm install -g nodemon  # If not already installed
npm run dev
```

### Adding New Intent Filters
1. Update the dropdown options in [`public/index.html`](public/index.html:39)
2. Modify the filtering logic in [`server.js`](server.js:47) if needed

### Customizing Follow-up Detection
Update the [`checkNeedsFollowUp`](server.js:77) method in [`server.js`](server.js) to add new detection rules.

## Troubleshooting

### Common Issues

1. **"Failed to fetch opportunities"**
   - Check your Salesforce credentials in `.env`
   - Verify your security token is current
   - Ensure API access is enabled for your user

2. **"Authentication failed"**
   - Reset your Salesforce security token
   - Check if your password has changed
   - Verify the login URL (use https://test.salesforce.com for sandboxes)

3. **No data showing**
   - Check if you have opportunities in the date ranges
   - Verify your user has access to the Opportunity object
   - Check the browser console for JavaScript errors

### Debug Tools

The dashboard includes built-in debug functions accessible in the browser console:

```javascript
// Get current data
dashboardDebug.getCurrentData()

// Refresh data manually
dashboardDebug.refreshData()

// Switch views programmatically
dashboardDebug.switchView('biweek')
dashboardDebug.switchView('fiveyard')
```

## Security Notes

- Never commit your `.env` file to version control
- Use environment-specific security tokens
- Consider implementing OAuth for production deployments
- Regularly rotate your Salesforce security tokens

## License

MIT License - see LICENSE file for details.

## Support

For issues and questions:
1. Check the troubleshooting section above
2. Review the browser console for error messages
3. Verify your Salesforce configuration
4. Ensure all dependencies are properly installed
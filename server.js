const express = require('express');
const jsforce = require('jsforce');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Salesforce Connection
class SalesforceService {
    constructor() {
        this.conn = new jsforce.Connection({
            loginUrl: process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com',
            version: process.env.SALESFORCE_API_VERSION || '58.0'
        });
        this.isConnected = false;
    }

    async connect() {
        try {
            if (!this.isConnected) {
                await this.conn.login(
                    process.env.SALESFORCE_USERNAME,
                    process.env.SALESFORCE_PASSWORD + process.env.SALESFORCE_SECURITY_TOKEN
                );
                this.isConnected = true;
                console.log('Successfully connected to Salesforce');
            }
            return this.conn;
        } catch (error) {
            console.error('Salesforce connection error:', error);
            throw error;
        }
    }

    async getAllOpportunities() {
        await this.connect();
        
        let fields = `
            Id, Name, StageName, Amount, CloseDate, CreatedDate, LastModifiedDate,
            AccountId, Account.Name, Owner.Name, NextStep, Description
        `;

        // Simplified query - we'll do filtering on the client side
        let query = `SELECT ${fields} FROM Opportunity ORDER BY LastModifiedDate DESC LIMIT 1000`;

        try {
            const result = await this.conn.query(query);
            
            // Filter out unwanted opportunities on the client side
            const filteredRecords = result.records.filter(opp => {
                const name = (opp.Name || '').toLowerCase();
                const ownerName = (opp.Owner?.Name || '').toLowerCase();
                
                // Exclude upgrade/design opportunities
                if (name.includes('upgrade') || name.includes('design')) {
                    return false;
                }
                
                // Exclude Roxy's opportunities
                if (ownerName.includes('roxy')) {
                    return false;
                }
                
                return true;
            });
            
            // Get last contact dates for all opportunities
            const opportunitiesWithContacts = await this.addLastContactDates(filteredRecords);
            
            return opportunitiesWithContacts;
        } catch (error) {
            console.error('Query error:', error);
            throw error;
        }
    }

    async addLastContactDates(opportunities) {
        if (!opportunities || opportunities.length === 0) {
            return opportunities;
        }

        try {
            // Process opportunities in smaller batches to avoid URI length issues
            const batchSize = 50; // Reduced batch size due to more complex queries
            const oppTaskDates = new Map();
            const oppEventDates = new Map();
            const accountTaskDates = new Map();
            const accountEventDates = new Map();

            // Process in batches
            for (let i = 0; i < opportunities.length; i += batchSize) {
                const batch = opportunities.slice(i, i + batchSize);
                const oppIds = batch.map(opp => `'${opp.Id}'`).join(',');
                
                // Filter out undefined/null AccountIds and create valid SQL list
                const validAccountIds = batch
                    .map(opp => opp.AccountId)
                    .filter(accountId => accountId && accountId !== 'undefined' && accountId !== 'null')
                    .map(accountId => `'${accountId}'`);
                const accountIds = validAccountIds.length > 0 ? validAccountIds.join(',') : null;
                
                console.log(`Querying activities for batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(opportunities.length/batchSize)} (${batch.length} opportunities, ${validAccountIds.length} valid accounts)`);
                
                // Query most recent Tasks for opportunities
                const oppTaskQuery = `
                    SELECT WhatId, MAX(CreatedDate) LastTaskDate
                    FROM Task
                    WHERE WhatId IN (${oppIds})
                    GROUP BY WhatId
                `;
                
                // Query most recent Events for opportunities
                const oppEventQuery = `
                    SELECT WhatId, MAX(CreatedDate) LastEventDate
                    FROM Event
                    WHERE WhatId IN (${oppIds})
                    GROUP BY WhatId
                `;

                // Query most recent Tasks for accounts (if we have valid account IDs)
                let accountTaskQuery = null;
                let accountEventQuery = null;
                if (accountIds && validAccountIds.length > 0) {
                    accountTaskQuery = `
                        SELECT WhatId, MAX(CreatedDate) LastTaskDate
                        FROM Task
                        WHERE WhatId IN (${accountIds})
                        GROUP BY WhatId
                    `;
                    
                    accountEventQuery = `
                        SELECT WhatId, MAX(CreatedDate) LastEventDate
                        FROM Event
                        WHERE WhatId IN (${accountIds})
                        GROUP BY WhatId
                    `;
                }

                // Execute all queries with proper Promise handling
                const queryOppTasks = () => new Promise((resolve) => {
                    this.conn.query(oppTaskQuery, (err, result) => {
                        if (err) {
                            console.log(`Opportunity task query failed for batch ${Math.floor(i/batchSize) + 1}:`, err.message);
                            resolve({ records: [] });
                        } else {
                            resolve(result);
                        }
                    });
                });

                const queryOppEvents = () => new Promise((resolve) => {
                    this.conn.query(oppEventQuery, (err, result) => {
                        if (err) {
                            console.log(`Opportunity event query failed for batch ${Math.floor(i/batchSize) + 1}:`, err.message);
                            resolve({ records: [] });
                        } else {
                            resolve(result);
                        }
                    });
                });

                const queryAccountTasks = () => new Promise((resolve) => {
                    if (!accountTaskQuery) {
                        resolve({ records: [] });
                        return;
                    }
                    this.conn.query(accountTaskQuery, (err, result) => {
                        if (err) {
                            console.log(`Account task query failed for batch ${Math.floor(i/batchSize) + 1}:`, err.message);
                            resolve({ records: [] });
                        } else {
                            resolve(result);
                        }
                    });
                });

                const queryAccountEvents = () => new Promise((resolve) => {
                    if (!accountEventQuery) {
                        resolve({ records: [] });
                        return;
                    }
                    this.conn.query(accountEventQuery, (err, result) => {
                        if (err) {
                            console.log(`Account event query failed for batch ${Math.floor(i/batchSize) + 1}:`, err.message);
                            resolve({ records: [] });
                        } else {
                            resolve(result);
                        }
                    });
                });

                const [oppTaskResult, oppEventResult, accountTaskResult, accountEventResult] = await Promise.all([
                    queryOppTasks(),
                    queryOppEvents(),
                    queryAccountTasks(),
                    queryAccountEvents()
                ]);

                // Add batch results to our maps
                oppTaskResult.records.forEach(record => {
                    oppTaskDates.set(record.WhatId, record.LastTaskDate);
                });
                
                oppEventResult.records.forEach(record => {
                    oppEventDates.set(record.WhatId, record.LastEventDate);
                });

                accountTaskResult.records.forEach(record => {
                    accountTaskDates.set(record.WhatId, record.LastTaskDate);
                });
                
                accountEventResult.records.forEach(record => {
                    accountEventDates.set(record.WhatId, record.LastEventDate);
                });
            }

            console.log(`Activity query completed. Found ${oppTaskDates.size} opp task dates, ${oppEventDates.size} opp event dates, ${accountTaskDates.size} account task dates, and ${accountEventDates.size} account event dates.`);

            // Add last contact dates to opportunities
            return opportunities.map(opp => {
                // Get all possible activity dates for this opportunity
                const oppTaskDate = oppTaskDates.get(opp.Id);
                const oppEventDate = oppEventDates.get(opp.Id);
                const accountTaskDate = accountTaskDates.get(opp.AccountId);
                const accountEventDate = accountEventDates.get(opp.AccountId);
                
                // Collect all valid dates
                const allDates = [oppTaskDate, oppEventDate, accountTaskDate, accountEventDate]
                    .filter(date => date) // Remove null/undefined dates
                    .map(date => new Date(date)); // Convert to Date objects
                
                // Find the most recent activity date across all sources
                let lastContactDate = null;
                if (allDates.length > 0) {
                    lastContactDate = new Date(Math.max(...allDates)).toISOString();
                }
                
                // Fall back to LastModifiedDate if no activities
                if (!lastContactDate) {
                    lastContactDate = opp.LastModifiedDate;
                }
                
                return {
                    ...opp,
                    LastContactDate: lastContactDate
                };
            });
            
        } catch (error) {
            console.error('Error getting activity dates:', error);
            // If there's an error, just return opportunities with LastModifiedDate as contact date
            return opportunities.map(opp => ({
                ...opp,
                LastContactDate: opp.LastModifiedDate
            }));
        }
    }

    // Old getOpportunities method removed - now using local database via DatabaseService
}

// OpenAI Engagement Analysis Service
class EngagementAnalysisService {
    constructor() {
        if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your-openai-api-key-here') {
            this.openai = new OpenAI({
                apiKey: process.env.OPENAI_API_KEY
            });
        } else {
            console.log('OpenAI API key not configured - AI features will be disabled');
            this.openai = null;
        }
    }

    async analyzeEngagement(opportunity) {
        if (!this.openai) {
            return {
                engagement: 'OpenAI API key not configured',
                hasEngagement: false,
                score: 0
            };
        }

        const prompt = `Analyze the engagement level for this sales opportunity and provide a JSON response:

Opportunity Details:
- Name: ${opportunity.name || 'N/A'}
- Description: ${opportunity.description || 'N/A'}
- Notes: ${opportunity.custom_notes || 'N/A'}
- Stage: ${opportunity.stage || 'N/A'}
- Account: ${opportunity.account_name || 'N/A'}
- Owner: ${opportunity.owner_name || 'N/A'}
- Next Step: ${opportunity.next_step || 'N/A'}

Please respond with a JSON object containing:
{
  "score": <number 1-5>,
  "reasoning": "<brief explanation>",
  "hasEngagement": <boolean>
}

Score 1 = No engagement, Score 5 = Highly engaged`;

        try {
            const response = await this.openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || 'gpt-4-turbo-preview',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 300,
                temperature: 0.3
            });

            const content = response.choices[0].message.content.trim();
            
            // Try to parse JSON response
            try {
                const parsed = JSON.parse(content);
                return {
                    engagement: parsed.reasoning || 'Analysis completed',
                    hasEngagement: parsed.hasEngagement !== false && parsed.score > 2,
                    score: parsed.score || 0
                };
            } catch (jsonError) {
                // Fallback if JSON parsing fails
                const hasEngagement = content.toLowerCase().includes('engage') &&
                                    !content.toLowerCase().includes('no engagement');
                return {
                    engagement: content,
                    hasEngagement: hasEngagement,
                    score: hasEngagement ? 3 : 1
                };
            }
        } catch (error) {
            console.error('OpenAI analysis failed:', error);
            return {
                engagement: 'Analysis failed - ' + error.message,
                hasEngagement: false,
                score: 0
            };
        }
    }
}

// Database Service for local storage
class DatabaseService {
    constructor() {
        this.db = null;
        this.initDatabase();
    }

    initDatabase() {
        this.db = new sqlite3.Database('./opportunities.db', (err) => {
            if (err) {
                console.error('Error opening database:', err);
            } else {
                console.log('Connected to SQLite database');
                this.createTables();
            }
        });
    }

    createTables() {
        // Opportunities table with Salesforce data + custom fields + engagement analysis
        const createOpportunitiesTable = `
            CREATE TABLE IF NOT EXISTS opportunities (
                id TEXT PRIMARY KEY,
                sf_id TEXT UNIQUE,
                name TEXT,
                stage TEXT,
                amount REAL,
                close_date TEXT,
                created_date TEXT,
                last_modified TEXT,
                last_contact_date TEXT,
                account_name TEXT,
                owner_name TEXT,
                next_step TEXT,
                description TEXT,
                priority_level INTEGER DEFAULT 1,
                custom_notes TEXT,
                follow_up_date TEXT,
                customer_preferences TEXT,
                location TEXT,
                last_sync TEXT,
                is_active INTEGER DEFAULT 1,
                engagement_score INTEGER DEFAULT 0,
                engagement_analysis TEXT,
                has_engagement INTEGER DEFAULT 0,
                engagement_analyzed_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `;
        
        // Add the new column if it doesn't exist (for existing databases)
        const addLastContactDateColumn = `
            ALTER TABLE opportunities
            ADD COLUMN last_contact_date TEXT
        `;

        // User preferences table for client customizations
        const createUserPreferencesTable = `
            CREATE TABLE IF NOT EXISTS user_preferences (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT DEFAULT 'default',
                opportunity_id TEXT,
                priority_color TEXT DEFAULT 'gray',
                intent_level INTEGER DEFAULT 5,
                five_yard_line INTEGER DEFAULT 0,
                follow_up_date TEXT,
                position_x REAL,
                position_y REAL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, opportunity_id),
                FOREIGN KEY (opportunity_id) REFERENCES opportunities (sf_id)
            )
        `;

        // Sync log table to track when data was last updated
        const createSyncLogTable = `
            CREATE TABLE IF NOT EXISTS sync_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sync_type TEXT,
                sync_status TEXT,
                records_synced INTEGER,
                error_message TEXT,
                sync_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `;

        this.db.run(createOpportunitiesTable, (err) => {
            if (err) console.error('Error creating opportunities table:', err);
            else console.log('Opportunities table ready');
        });

        // Try to add the new column for existing databases (will fail silently if column exists)
        this.db.run(addLastContactDateColumn, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding last_contact_date column:', err);
            }
        });

        this.db.run(createUserPreferencesTable, (err) => {
            if (err) console.error('Error creating user_preferences table:', err);
            else console.log('User preferences table ready');
        });

        this.db.run(createSyncLogTable, (err) => {
            if (err) console.error('Error creating sync_log table:', err);
            else console.log('Sync log table ready');
        });
    }

    async syncFromSalesforce(salesforceService) {
        try {
            console.log('Starting Salesforce sync...');
            
            // Get all opportunities from Salesforce
            const sfOpportunities = await salesforceService.getAllOpportunities();
            
            let syncedCount = 0;
            
            for (const opp of sfOpportunities) {
                await this.upsertOpportunity(opp);
                syncedCount++;
            }

            // Log successful sync
            await this.logSync('full_sync', 'success', syncedCount);
            
            console.log(`Synced ${syncedCount} opportunities from Salesforce`);
            return { success: true, count: syncedCount };
        } catch (error) {
            console.error('Sync error:', error);
            await this.logSync('full_sync', 'error', 0, error.message);
            throw error;
        }
    }

    async upsertOpportunity(sfOpp) {
        return new Promise((resolve, reject) => {
            const parsedInfo = this.parseOpportunityName(sfOpp.Name);
            
            const sql = `
                INSERT OR REPLACE INTO opportunities (
                    sf_id, name, stage, amount, close_date, created_date, last_modified, last_contact_date,
                    account_name, owner_name, next_step, description, customer_preferences,
                    location, last_sync, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `;
            
            const params = [
                sfOpp.Id,
                sfOpp.Name,
                sfOpp.StageName,
                sfOpp.Amount,
                sfOpp.CloseDate,
                sfOpp.CreatedDate,
                sfOpp.LastModifiedDate,
                sfOpp.LastContactDate,
                sfOpp.Account?.Name,
                sfOpp.Owner?.Name,
                sfOpp.NextStep,
                sfOpp.Description,
                parsedInfo.preferences || '',
                parsedInfo.location,
                new Date().toISOString()
            ];

            this.db.run(sql, params, function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
        });
    }

    parseOpportunityName(opportunityName) {
        const parts = (opportunityName || '').split(',');
        
        let customerName = '';
        let location = '';
        let preferences = '';
        
        if (parts.length > 0) {
            const firstPart = parts[0].trim();
            const locationMatch = firstPart.match(/^(.+?)\s*-\s*([A-Z]{2}|[A-Za-z\s]+)$/);
            
            if (locationMatch) {
                customerName = locationMatch[1].trim();
                location = locationMatch[2].trim();
            } else {
                customerName = firstPart;
                location = 'N/A';
            }
            
            if (parts.length > 1) {
                preferences = parts.slice(1).join(', ').trim();
            }
        } else {
            customerName = opportunityName;
            location = 'N/A';
        }
        
        return { customerName, location, preferences };
    }

    async getOpportunities(filters = {}) {
        return new Promise((resolve, reject) => {
            let sql = `
                SELECT * FROM opportunities
                WHERE is_active = 1
            `;
            
            const params = [];
            
            // Apply filters
            if (filters.excludeOwner) {
                sql += ` AND LOWER(owner_name) NOT LIKE LOWER(?)`;
                params.push(`%${filters.excludeOwner}%`);
            }
            
            if (filters.excludeUpgradeDesign) {
                sql += ` AND LOWER(name) NOT LIKE '%upgrade%' AND LOWER(name) NOT LIKE '%design%'`;
            }
            
            if (filters.week) {
                const { startDate, endDate } = this.getWeekDateRange(filters.week);
                sql += ` AND created_date >= ? AND created_date <= ?`;
                params.push(startDate.toISOString(), endDate.toISOString());
            }
            
            if (filters.viewType === 'fiveyard') {
                const thirtyDaysFromNow = new Date();
                thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
                sql += ` AND (close_date <= ? OR stage IN ('Proposal/Price Quote', 'Negotiation/Review', 'Closed Won'))`;
                params.push(thirtyDaysFromNow.toISOString().split('T')[0]);
            }
            
            // Priority filtering is handled on the frontend, not in database
            // Remove database-level priority filtering since priority_color column doesn't exist
            
            sql += ` ORDER BY last_modified DESC LIMIT 100`;
            
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows.map(row => this.formatOpportunity(row)));
                }
            });
        });
    }

    formatOpportunity(row) {
        return {
            id: row.sf_id,
            name: row.name,
            stage: row.stage,
            amount: row.amount,
            closeDate: row.close_date,
            createdDate: row.created_date,
            lastModified: row.last_modified,
            lastContactDate: row.last_contact_date || row.last_modified,
            accountName: row.account_name,
            ownerName: row.owner_name,
            nextStep: row.next_step,
            description: row.description,
            priorityLevel: row.priority_level,
            customNotes: row.custom_notes,
            followUpDate: row.follow_up_date,
            customerPreferences: row.customer_preferences,
            location: row.location,
            needsFollowUp: this.checkNeedsFollowUp(row),
            followUpReason: this.getFollowUpReason(row)
        };
    }

    checkNeedsFollowUp(opp) {
        // Check follow-up date
        if (opp.follow_up_date) {
            const followUpDate = new Date(opp.follow_up_date);
            if (followUpDate <= new Date()) {
                return true;
            }
        }
        
        // Check next step date
        if (opp.next_step) {
            const nextStepDate = new Date(opp.next_step);
            if (nextStepDate <= new Date()) {
                return true;
            }
        }
        
        return false;
    }

    getFollowUpReason(opp) {
        if (opp.follow_up_date && new Date(opp.follow_up_date) <= new Date()) {
            return 'Custom follow-up date reached';
        }
        if (opp.next_step && new Date(opp.next_step) <= new Date()) {
            return 'Next step date passed';
        }
        return null;
    }

    getWeekDateRange(weekString) {
        if (!weekString) return null;
        
        const [year, weekStr] = weekString.split('-W');
        const weekNum = parseInt(weekStr);
        const yearInt = parseInt(year);
        
        // ISO week calculation
        const simple = new Date(yearInt, 0, 1 + (weekNum - 1) * 7);
        const dow = simple.getDay();
        const ISOweekStart = simple;
        if (dow <= 4)
            ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
        else
            ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());
        
        const weekStart = new Date(ISOweekStart);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        
        return { startDate: weekStart, endDate: weekEnd };
    }

    async updatePriority(opportunityId, priorityLevel) {
        return new Promise((resolve, reject) => {
            const sql = `UPDATE opportunities SET priority_level = ?, updated_at = CURRENT_TIMESTAMP WHERE sf_id = ?`;
            this.db.run(sql, [priorityLevel, opportunityId], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            });
        });
    }

    async updateCustomNotes(opportunityId, notes) {
        return new Promise((resolve, reject) => {
            const sql = `UPDATE opportunities SET custom_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE sf_id = ?`;
            this.db.run(sql, [notes, opportunityId], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            });
        });
    }

    async setFollowUpDate(opportunityId, followUpDate) {
        return new Promise((resolve, reject) => {
            const sql = `UPDATE opportunities SET follow_up_date = ?, updated_at = CURRENT_TIMESTAMP WHERE sf_id = ?`;
            this.db.run(sql, [followUpDate, opportunityId], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            });
        });
    }

    async logSync(syncType, status, recordsCount, errorMessage = null) {
        return new Promise((resolve, reject) => {
            const sql = `INSERT INTO sync_log (sync_type, sync_status, records_synced, error_message) VALUES (?, ?, ?, ?)`;
            this.db.run(sql, [syncType, status, recordsCount, errorMessage], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
        });
    }

    async getLastSync() {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM sync_log ORDER BY sync_timestamp DESC LIMIT 1`;
            this.db.get(sql, [], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    async saveUserPreferences(userId = 'default', preferences) {
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT OR REPLACE INTO user_preferences
                (user_id, opportunity_id, priority_color, intent_level, five_yard_line, follow_up_date, position_x, position_y, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `;
            const params = [
                userId,
                preferences.opportunity_id,
                preferences.priority_color || 'gray',
                preferences.intent_level || 5,
                preferences.five_yard_line ? 1 : 0,
                preferences.follow_up_date || null,
                preferences.position_x || null,
                preferences.position_y || null
            ];
            
            this.db.run(sql, params, function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            });
        });
    }

    async getUserPreferences(userId = 'default', opportunityId) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM user_preferences WHERE user_id = ? AND opportunity_id = ?`;
            this.db.get(sql, [userId, opportunityId], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    async getAllUserPreferences(userId = 'default') {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM user_preferences WHERE user_id = ?`;
            this.db.all(sql, [userId], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async saveMultipleUserPreferences(userId = 'default', preferencesArray) {
        return new Promise((resolve, reject) => {
            const stmt = this.db.prepare(`
                INSERT OR REPLACE INTO user_preferences
                (user_id, opportunity_id, priority_color, intent_level, five_yard_line, follow_up_date, position_x, position_y, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `);

            this.db.serialize(() => {
                this.db.run("BEGIN TRANSACTION");
                
                try {
                    preferencesArray.forEach(pref => {
                        stmt.run([
                            userId,
                            pref.opportunity_id,
                            pref.priority_color || 'gray',
                            pref.intent_level || 5,
                            pref.five_yard_line ? 1 : 0,
                            pref.follow_up_date || null,
                            pref.position_x || null,
                            pref.position_y || null
                        ]);
                    });
                    
                    this.db.run("COMMIT", (err) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(preferencesArray.length);
                        }
                    });
                } catch (error) {
                    this.db.run("ROLLBACK");
                    reject(error);
                } finally {
                    stmt.finalize();
                }
            });
        });
    }
}

const salesforceService = new SalesforceService();
const databaseService = new DatabaseService();
const engagementService = new EngagementAnalysisService();

// Ensure database is initialized before starting server
setTimeout(() => {
    console.log('Database should be initialized now');
}, 2000);

// API Routes
app.get('/api/opportunities', async (req, res) => {
    try {
        const { view = 'weekly', priority, week } = req.query;
        
        const filters = {
            excludeOwner: 'Roxy',
            excludeUpgradeDesign: true,
            viewType: view,
            week: week,
            priority: priority
        };
        
        const opportunities = await databaseService.getOpportunities(filters);
        res.json(opportunities);
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: 'Failed to fetch opportunities from database' });
    }
});

// Sync opportunities from Salesforce
app.post('/api/sync', async (req, res) => {
    try {
        const result = await databaseService.syncFromSalesforce(salesforceService);
        res.json({
            success: true,
            message: `Synced ${result.count} opportunities from Salesforce`,
            count: result.count
        });
    } catch (error) {
        console.error('Sync Error:', error);
        res.status(500).json({ error: 'Failed to sync from Salesforce', details: error.message });
    }
});

// Update opportunity priority
app.put('/api/opportunities/:id/priority', async (req, res) => {
    try {
        const { id } = req.params;
        const { priority } = req.body;
        
        if (!priority || priority < 1 || priority > 5) {
            return res.status(400).json({ error: 'Priority must be between 1 and 5' });
        }
        
        await databaseService.updatePriority(id, priority);
        res.json({ success: true, message: 'Priority updated' });
    } catch (error) {
        console.error('Priority Update Error:', error);
        res.status(500).json({ error: 'Failed to update priority' });
    }
});

// Update opportunity custom notes
app.put('/api/opportunities/:id/notes', async (req, res) => {
    try {
        const { id } = req.params;
        const { notes } = req.body;
        
        await databaseService.updateCustomNotes(id, notes);
        res.json({ success: true, message: 'Notes updated' });
    } catch (error) {
        console.error('Notes Update Error:', error);
        res.status(500).json({ error: 'Failed to update notes' });
    }
});

// Set follow-up date
app.put('/api/opportunities/:id/followup', async (req, res) => {
    try {
        const { id } = req.params;
        const { followUpDate } = req.body;
        
        await databaseService.setFollowUpDate(id, followUpDate);
        res.json({ success: true, message: 'Follow-up date set' });
    } catch (error) {
        console.error('Follow-up Update Error:', error);
        res.status(500).json({ error: 'Failed to set follow-up date' });
    }
});

// Get sync status
app.get('/api/sync/status', async (req, res) => {
    try {
        const lastSync = await databaseService.getLastSync();
        res.json({
            lastSync: lastSync,
            hasData: !!lastSync
        });
    } catch (error) {
        console.error('Sync Status Error:', error);
        res.status(500).json({ error: 'Failed to get sync status' });
    }
});

// User Preferences API Routes
app.get('/api/user-preferences', async (req, res) => {
    try {
        const userId = req.query.user_id || 'default';
        const preferences = await databaseService.getAllUserPreferences(userId);
        res.json(preferences);
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: 'Failed to fetch user preferences' });
    }
});

app.get('/api/user-preferences/:opportunityId', async (req, res) => {
    try {
        const { opportunityId } = req.params;
        const userId = req.query.user_id || 'default';
        const preferences = await databaseService.getUserPreferences(userId, opportunityId);
        res.json(preferences);
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: 'Failed to fetch user preferences for opportunity' });
    }
});

app.post('/api/user-preferences', async (req, res) => {
    try {
        const { user_id = 'default', preferences } = req.body;
        
        if (Array.isArray(preferences)) {
            // Bulk save multiple preferences
            await databaseService.saveMultipleUserPreferences(user_id, preferences);
            res.json({ success: true, message: `${preferences.length} preferences saved` });
        } else {
            // Save single preference
            await databaseService.saveUserPreferences(user_id, preferences);
            res.json({ success: true, message: 'User preferences saved' });
        }
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: 'Failed to save user preferences' });
    }
});

app.post('/api/user-preferences/bulk', async (req, res) => {
    try {
        const { user_id = 'default', preferences } = req.body;
        
        if (!Array.isArray(preferences)) {
            return res.status(400).json({ error: 'Preferences must be an array' });
        }
        
        const saved = await databaseService.saveMultipleUserPreferences(user_id, preferences);
        res.json({ success: true, message: `${saved} preferences saved` });
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: 'Failed to bulk save user preferences' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Serve the main dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    
    // Automatic sync disabled - use /api/sync endpoint to manually sync when SF credentials are fixed
    console.log('Auto-sync disabled. Dashboard ready. Use /api/sync to manually sync with Salesforce.');
});
class SalesforceDashboard {
    constructor() {
        this.currentView = 'weekly';
        this.currentData = [];
        this.currentPriority = '';
        this.selectedWeek = '';
        this.userPreferences = new Map(); // Store user's manual settings
        this.currentOpportunity = null; // For modal editing
        this.lastSuccessMessage = null; // Prevent duplicate messages
        this.successMessageTimeout = null; // Debounce timeout
        this.isDragging = false; // Track drag state
        this.dragUpdateTimeout = null; // Debounce drag updates
        this.containerBounds = null; // Cache container measurements
        this.syncTimer = null; // Auto-sync timer
        this.hasPendingChanges = false; // Track if changes need syncing
        this.lastSyncTime = 0; // Prevent sync spam
        this.minSyncInterval = 500; // Minimum 500ms between syncs
        
        this.initializeEventListeners();
        this.updateTodayDisplay();
        this.initializeApp(); // Load preferences first, then data
    }

    async initializeApp() {
        try {
            // Load user preferences first
            await this.loadUserPreferences();
            // Then load and render data
            await this.loadData();
        } catch (error) {
            console.error('Failed to initialize app:', error);
            // Still load data even if preferences fail
            this.loadData();
        }
    }

    initializeEventListeners() {
        // View toggle buttons
        document.getElementById('weekly-btn').addEventListener('click', () => this.switchView('weekly'));
        document.getElementById('fiveyard-btn').addEventListener('click', () => this.switchView('fiveyard'));
        document.getElementById('followups-btn').addEventListener('click', () => this.switchView('followups'));
        
        // Priority filter
        document.getElementById('priority-select').addEventListener('change', (e) => {
            this.currentPriority = e.target.value;
            this.renderView(); // Filter existing data instead of reloading from server
        });
        
        // Week picker
        document.getElementById('week-picker').addEventListener('change', (e) => {
            this.selectedWeek = e.target.value;
            this.loadData();
        });
        
        // Week navigation buttons
        document.getElementById('week-prev-btn').addEventListener('click', () => this.navigateWeek(-1));
        document.getElementById('week-next-btn').addEventListener('click', () => this.navigateWeek(1));
        
        // Sync button
        document.getElementById('sync-btn').addEventListener('click', () => this.syncFromSalesforce());
        
        // Set default week to current week using backend's calculation
        const today = new Date();
        const year = today.getFullYear();
        const week = this.getBackendWeekNumber(today);
        const weekString = `${year}-W${week.toString().padStart(2, '0')}`;
        document.getElementById('week-picker').value = weekString;
        this.selectedWeek = weekString;
        
        // Load sync status
        this.loadSyncStatus();
        
        // Modal close
        document.getElementById('close-modal').addEventListener('click', () => this.closeModal());
        document.getElementById('card-modal').addEventListener('click', (e) => {
            if (e.target.id === 'card-modal') {
                this.closeModal();
            }
        });
        
        // Manual controls
        document.getElementById('save-changes-btn').addEventListener('click', () => this.saveOpportunityPreferences());
        
        // Priority and Intent button groups - use event delegation since buttons are in modal
        document.addEventListener('click', (e) => {
            // Priority button selection
            if (e.target.classList.contains('priority-btn')) {
                document.querySelectorAll('.priority-btn').forEach(btn => btn.classList.remove('active'));
                e.target.classList.add('active');
            }
            
            // Intent button selection
            if (e.target.classList.contains('intent-btn')) {
                document.querySelectorAll('.intent-btn').forEach(btn => btn.classList.remove('active'));
                e.target.classList.add('active');
            }
        });
        
        // Follow-up date controls
        document.getElementById('clear-followup-btn').addEventListener('click', () => this.clearFollowUpDate());
        document.getElementById('complete-followup-btn').addEventListener('click', () => this.completeFollowUp());
        
        // Follow-ups view controls
        document.getElementById('followup-date-filter').addEventListener('change', (e) => {
            this.selectedFollowUpDate = e.target.value;
            if (this.currentView === 'followups') {
                this.renderFollowupsView();
            }
        });
        
        // Set default follow-up date to today
        const currentDate = new Date();
        const todayString = currentDate.toISOString().split('T')[0];
        document.getElementById('followup-date-filter').value = todayString;
        this.selectedFollowUpDate = todayString;
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeModal();
            }
            if (e.key === '1' && e.ctrlKey) {
                e.preventDefault();
                this.switchView('biweek');
            }
            if (e.key === '2' && e.ctrlKey) {
                e.preventDefault();
                this.switchView('fiveyard');
            }
        });
    }

    async loadData() {
        this.showLoading();
        this.hideError();
        
        // Ensure user preferences are loaded before processing data
        if (this.userPreferences.size === 0) {
            console.log('User preferences not loaded yet, loading...');
            await this.loadUserPreferences();
        }
        
        try {
            const params = new URLSearchParams({
                view: this.currentView,
                ...(this.currentPriority && { priority: this.currentPriority }),
                // Only send week parameter for weekly view - fiveyard and followups should show all data
                ...(this.currentView === 'weekly' && this.selectedWeek && { week: this.selectedWeek })
            });
            
            const response = await fetch(`/api/opportunities?${params}`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            this.currentData = data;
            this.renderView();
            this.hideLoading();
        } catch (error) {
            console.error('Error loading data:', error);
            this.showError('Failed to load opportunities. Please check your Salesforce connection.');
            this.hideLoading();
        }
    }

    switchView(viewType) {
        if (this.currentView === viewType) return;
        
        this.currentView = viewType;
        
        // Update active button
        document.querySelectorAll('.view-tab').forEach(btn => btn.classList.remove('active'));
        document.getElementById(`${viewType}-btn`).classList.add('active');
        
        // Update active view container
        document.querySelectorAll('.view-container').forEach(container => container.classList.remove('active'));
        document.getElementById(`${viewType}-view`).classList.add('active');
        
        this.loadData();
    }

    renderView() {
        if (this.currentView === 'weekly') {
            this.renderWeeklyView();
        } else if (this.currentView === 'fiveyard') {
            this.renderFiveYardView();
        } else if (this.currentView === 'followups') {
            this.renderFollowupsView();
        }
    }

    filterOpportunitiesByPriority(opportunities) {
        if (!this.currentPriority) {
            return opportunities; // No priority filter, return all
        }
        
        return opportunities.filter(opp => {
            const userPref = this.userPreferences.get(opp.id) || {};
            const oppPriority = userPref.priority || 'gray'; // Default to gray if no priority set
            return oppPriority === this.currentPriority;
        });
    }

    // Check if opportunity needs follow-up, considering user preferences
    checkNeedsFollowUp(opportunity) {
        const userPref = this.userPreferences.get(opportunity.id) || {};
        const followUpDate = userPref.followUpDate || opportunity.followUpDate;
        
        if (followUpDate) {
            const followUpDateObj = new Date(followUpDate);
            const today = new Date();
            today.setHours(0, 0, 0, 0); // Start of today
            followUpDateObj.setHours(0, 0, 0, 0); // Start of follow-up date
            
            if (followUpDateObj <= today) {
                return true;
            }
        }
        
        // Fall back to server-side logic for other criteria
        return opportunity.needsFollowUp;
    }

    renderWeeklyView() {
        // Clear existing cards
        const dayContainers = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'weekend'];
        dayContainers.forEach(day => {
            const container = document.getElementById(`${day}-cards`);
            if (container) {
                container.innerHTML = '';
            }
        });

        // Filter by priority first, then group by weekday
        const filteredData = this.filterOpportunitiesByPriority(this.currentData);
        const groupedData = this.groupByWeekday(filteredData);
        
        Object.entries(groupedData).forEach(([day, opportunities]) => {
            const container = document.getElementById(`${day}-cards`);
            if (container && opportunities.length > 0) {
                opportunities.forEach(opp => {
                    container.appendChild(this.createOpportunityCard(opp));
                });
            }
        });
    }

    renderFiveYardView() {
        const container = document.getElementById('horizontal-cards');
        if (!container) return;
        
        // Clear cached bounds when re-rendering
        this.containerBounds = null;
        
        container.innerHTML = '';
        
        // Filter by priority first, then filter for five-yard line opportunities
        const filteredData = this.filterOpportunitiesByPriority(this.currentData);
        const fiveYardOpportunities = filteredData.filter(opp => {
            const userPref = this.userPreferences.get(opp.id) || {};
            return userPref.fiveYardLine;
        });
        
        // Sort five-yard opportunities by priority
        fiveYardOpportunities.sort((a, b) => {
            const aPref = this.userPreferences.get(a.id) || {};
            const bPref = this.userPreferences.get(b.id) || {};
            const aPriority = aPref.priority || 'gray';
            const bPriority = bPref.priority || 'gray';
            
            const priorityRank = {
                'red': 1,     // High Priority
                'yellow': 2,  // Medium Priority
                'blue': 3,    // Info Priority
                'gray': 4,    // No Priority (Default)
                'green': 5    // Low Priority
            };
            
            const aPriorityRank = priorityRank[aPriority] || 4;
            const bPriorityRank = priorityRank[bPriority] || 4;
            
            return aPriorityRank - bPriorityRank;
        });
        
        fiveYardOpportunities.forEach(opp => {
            const card = this.createOpportunityCard(opp);
            card.classList.add('horizontal');
            container.appendChild(card);
        });
        
        // Update stats based on filtered data
        const needsFollowUp = filteredData.filter(opp => this.checkNeedsFollowUp(opp)).length;
        document.getElementById('fiveyard-followup').textContent = needsFollowUp;
        
        // Initialize horizontal drag and drop
        this.initializeHorizontalDropZone();
    }

    renderFollowupsView() {
        const container = document.getElementById('followups-cards');
        if (!container) return;
        
        container.innerHTML = '';
        
        // Filter by priority first, then by follow-up date
        const filteredData = this.filterOpportunitiesByPriority(this.currentData);
        const targetDate = this.selectedFollowUpDate || new Date().toISOString().split('T')[0];
        const followupOpportunities = filteredData.filter(opp => {
            const userPref = this.userPreferences.get(opp.id) || {};
            const followUpDate = userPref.followUpDate || opp.followUpDate;
            if (!followUpDate) return false;
            const oppFollowupDate = new Date(followUpDate).toISOString().split('T')[0];
            return oppFollowupDate === targetDate;
        });
        
        // Sort follow-up opportunities by priority
        followupOpportunities.sort((a, b) => {
            const aPref = this.userPreferences.get(a.id) || {};
            const bPref = this.userPreferences.get(b.id) || {};
            const aPriority = aPref.priority || 'gray';
            const bPriority = bPref.priority || 'gray';
            
            const priorityRank = {
                'red': 1,     // High Priority
                'yellow': 2,  // Medium Priority
                'blue': 3,    // Info Priority
                'gray': 4,    // No Priority (Default)
                'green': 5    // Low Priority
            };
            
            const aPriorityRank = priorityRank[aPriority] || 4;
            const bPriorityRank = priorityRank[bPriority] || 4;
            
            return aPriorityRank - bPriorityRank;
        });
        
        // Update count
        const countElement = document.getElementById('followup-count');
        const count = followupOpportunities.length;
        countElement.textContent = `${count} follow-up${count !== 1 ? 's' : ''}`;
        
        // Render cards
        followupOpportunities.forEach(opp => {
            const card = this.createOpportunityCard(opp);
            card.classList.add('followup-card');
            container.appendChild(card);
        });
        
        if (followupOpportunities.length === 0) {
            container.innerHTML = '<div class="no-followups">No follow-ups scheduled for this date</div>';
        }
    }

    groupByWeekday(opportunities) {
        const dayMap = {
            monday: [],
            tuesday: [],
            wednesday: [],
            thursday: [],
            friday: [],
            weekend: []
        };
        
        opportunities.forEach(opp => {
            if (!opp.createdDate) return;
            
            const date = new Date(opp.createdDate);
            const dayOfWeek = date.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
            
            switch (dayOfWeek) {
                case 1:
                    dayMap.monday.push(opp);
                    break;
                case 2:
                    dayMap.tuesday.push(opp);
                    break;
                case 3:
                    dayMap.wednesday.push(opp);
                    break;
                case 4:
                    dayMap.thursday.push(opp);
                    break;
                case 5:
                    dayMap.friday.push(opp);
                    break;
                case 0:
                case 6:
                    dayMap.weekend.push(opp);
                    break;
            }
        });
        
        // Sort opportunities within each day: priority first, then stage
        Object.keys(dayMap).forEach(day => {
            dayMap[day].sort((a, b) => {
                // Get priority from user preferences
                const aPref = this.userPreferences.get(a.id) || {};
                const bPref = this.userPreferences.get(b.id) || {};
                const aPriority = aPref.priority || 'gray';
                const bPriority = bPref.priority || 'gray';
                
                // Define priority ranking (lower number = higher priority)
                const priorityRank = {
                    'red': 1,     // High Priority
                    'yellow': 2,  // Medium Priority
                    'blue': 3,    // Info Priority
                    'gray': 4,    // No Priority (Default)
                    'green': 5    // Low Priority
                };
                
                const aPriorityRank = priorityRank[aPriority] || 4;
                const bPriorityRank = priorityRank[bPriority] || 4;
                
                // Sort by priority first
                if (aPriorityRank !== bPriorityRank) {
                    return aPriorityRank - bPriorityRank;
                }
                
                // If priorities are the same, sort by stage
                const aStage = (a.stage || '').toLowerCase();
                const bStage = (b.stage || '').toLowerCase();
                
                const aIsClosedWon = aStage.includes('closed won');
                const bIsClosedWon = bStage.includes('closed won');
                const aIsClosedLost = aStage.includes('closed lost');
                const bIsClosedLost = bStage.includes('closed lost');
                
                // Closed won goes to top
                if (aIsClosedWon && !bIsClosedWon) return -1;
                if (!aIsClosedWon && bIsClosedWon) return 1;
                
                // Closed lost goes to bottom
                if (aIsClosedLost && !bIsClosedLost) return 1;
                if (!aIsClosedLost && bIsClosedLost) return -1;
                
                // Everything else stays in original order
                return 0;
            });
        });
        
        return dayMap;
    }

    groupByStage(opportunities) {
        const groups = { engaged: [], fiveyard: [], closedwon: [] };
        
        opportunities.forEach(opp => {
            const stage = opp.stage.toLowerCase();
            const userPref = this.userPreferences.get(opp.id) || {};
            
            if (stage.includes('closed won') || stage === 'closed won') {
                groups.closedwon.push(opp);
            } else if (userPref.fiveYardLine) {
                // User manually marked this as five-yard line
                groups.fiveyard.push(opp);
            } else {
                groups.engaged.push(opp);
            }
        });
        
        return groups;
    }

    createOpportunityCard(opportunity) {
        const card = document.createElement('div');
        const userPref = this.userPreferences.get(opportunity.id) || {};
        
        // Apply manual settings
        let cardClasses = ['opportunity-card'];
        if (this.checkNeedsFollowUp(opportunity)) cardClasses.push('needs-followup');
        if (userPref.priority) cardClasses.push(`priority-${userPref.priority}`);
        if (userPref.fiveYardLine) cardClasses.push('five-yard-line');
        
        // Add custom drag for five-yard view
        if (this.currentView === 'fiveyard') {
            cardClasses.push('draggable');
            card.draggable = false; // Disable HTML5 drag
        }
        
        card.className = cardClasses.join(' ');
        card.dataset.opportunityId = opportunity.id; // Add ID for optimization
        
        // Smart click handler that prevents clicks after dragging
        card.addEventListener('click', (e) => {
            // Check if we recently finished dragging
            if (card.dataset.recentlyDragged === 'true') {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
            this.showModal(opportunity);
        });
        
        // Add drag event listeners for five-yard view
        if (this.currentView === 'fiveyard') {
            this.addDragEventListeners(card, opportunity);
        }
        
        const parsedInfo = this.parseOpportunityName(opportunity.name);
        
        // Determine status tag
        let statusTag = '';
        if (opportunity.stage && opportunity.stage.toLowerCase().includes('closed won')) {
            statusTag = '<div class="status-tag won">Won</div>';
        } else if (opportunity.stage && opportunity.stage.toLowerCase().includes('closed lost')) {
            statusTag = '<div class="status-tag lost">Lost</div>';
        }
        
        card.innerHTML = `
            <div class="card-customer-name">${this.escapeHtml(parsedInfo.customerName)}</div>
            <div class="card-location">${this.escapeHtml(parsedInfo.location)}</div>
            <div class="card-last-contact">Last: ${this.formatDate(opportunity.lastContactDate)}</div>
            ${statusTag}
        `;
        
        // Position card horizontally in five-yard view (optimized)
        if (this.currentView === 'fiveyard') {
            this.positionCardHorizontally(card, opportunity);
        }
        
        return card;
    }

    parseOpportunityName(opportunityName) {
        // Parse opportunity names like "Lori Martin- TX, keep at beach, blush pink, white interior, march delivery of next year"
        const parts = opportunityName.split(',');
        
        let customerName = '';
        let location = '';
        
        if (parts.length > 0) {
            // Extract customer name and location from first part
            const firstPart = parts[0].trim();
            const locationMatch = firstPart.match(/^(.+?)\s*-\s*([A-Z]{2}|[A-Za-z\s]+)$/);
            
            if (locationMatch) {
                customerName = locationMatch[1].trim();
                location = locationMatch[2].trim();
            } else {
                customerName = firstPart;
                location = 'N/A';
            }
        } else {
            customerName = opportunityName;
            location = 'N/A';
        }
        
        return {
            customerName,
            location
        };
    }

    showModal(opportunity) {
        this.currentOpportunity = opportunity;
        const userPref = this.userPreferences.get(opportunity.id) || {};
        
        document.getElementById('modal-title').textContent = opportunity.name;
        document.getElementById('modal-account').textContent = opportunity.accountName || 'N/A';
        document.getElementById('modal-owner').textContent = opportunity.ownerName || 'N/A';
        document.getElementById('modal-amount').textContent = this.formatCurrency(opportunity.amount);
        document.getElementById('modal-closedate').textContent = this.formatDate(opportunity.closeDate);
        document.getElementById('modal-createddate').textContent = this.formatDate(opportunity.createdDate);
        document.getElementById('modal-stage').textContent = opportunity.stage;
        
        // Show/hide closed lost reason section
        const closedLostSection = document.getElementById('closed-lost-section');
        if (opportunity.stage && opportunity.stage.toLowerCase().includes('closed lost')) {
            document.getElementById('modal-closed-lost-reason').textContent = opportunity.closedLostReason || 'No reason provided';
            closedLostSection.style.display = 'block';
        } else {
            closedLostSection.style.display = 'none';
        }
        
        document.getElementById('modal-nextstep').textContent = opportunity.nextStep || 'N/A';
        document.getElementById('modal-description').textContent = opportunity.description || 'No description available';
        
        // Set manual controls
        document.getElementById('modal-fiveyard-checkbox').checked = userPref.fiveYardLine || false;
        
        // Set priority button active state
        const priorityButtons = document.querySelectorAll('.priority-btn');
        const selectedPriority = userPref.priority || 'gray';
        priorityButtons.forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.priority === selectedPriority) {
                btn.classList.add('active');
            }
        });
        
        // Set intent button active state
        const intentButtons = document.querySelectorAll('.intent-btn');
        const selectedIntent = userPref.intentLevel || 5;
        intentButtons.forEach(btn => {
            btn.classList.remove('active');
            if (parseInt(btn.dataset.intent) === selectedIntent) {
                btn.classList.add('active');
            }
        });
        
        // Set follow-up date - check user preferences first, then server data
        const followupDatePicker = document.getElementById('followup-date-picker');
        const preferredFollowUpDate = userPref.followUpDate || opportunity.followUpDate;
        if (preferredFollowUpDate) {
            followupDatePicker.value = this.formatDateForInput(preferredFollowUpDate);
        } else {
            followupDatePicker.value = '';
        }
        
        // Tasks
        const tasksContainer = document.getElementById('modal-tasks');
        const tasksSection = document.getElementById('tasks-section');
        if (opportunity.tasks && opportunity.tasks.length > 0) {
            tasksContainer.innerHTML = opportunity.tasks.map(task =>
                `<li>${this.escapeHtml(task.Subject)} - ${this.formatDate(task.ActivityDate)}</li>`
            ).join('');
            tasksSection.style.display = 'block';
        } else {
            tasksSection.style.display = 'none';
        }
        
        // Notes
        const notesContainer = document.getElementById('modal-notes');
        const notesSection = document.getElementById('notes-section');
        if (opportunity.latestNote && opportunity.latestNote.Body) {
            notesContainer.textContent = opportunity.latestNote.Body;
            notesSection.style.display = 'block';
        } else {
            notesSection.style.display = 'none';
        }
        
        document.getElementById('card-modal').classList.remove('hidden');
    }

    closeModal() {
        document.getElementById('card-modal').classList.add('hidden');
    }

    showLoading() {
        document.getElementById('loading').classList.remove('hidden');
    }

    hideLoading() {
        document.getElementById('loading').classList.add('hidden');
    }

    showError(message) {
        document.getElementById('error-text').textContent = message;
        document.getElementById('error-message').classList.remove('hidden');
    }

    hideError() {
        document.getElementById('error-message').classList.add('hidden');
    }

    getStageClass(stage) {
        const stageLower = stage.toLowerCase();
        if (stageLower.includes('closed won')) {
            return 'closed-won';
        } else if (stageLower.includes('negotiation')) {
            return 'negotiation';
        } else if (stageLower.includes('proposal')) {
            return 'proposal';
        }
        return '';
    }

    formatCurrency(amount) {
        if (!amount) return '$0';
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        }).format(amount);
    }

    formatDate(dateString) {
        if (!dateString) return 'N/A';
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    }

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    getWeekNumber(date) {
        const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        const dayNum = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    }

    getBackendWeekNumber(date) {
        // Standard week calculation - week starts on Monday
        const target = new Date(date.valueOf());
        const dayNr = (date.getDay() + 6) % 7;
        target.setDate(target.getDate() - dayNr + 3);
        const firstThursday = target.valueOf();
        target.setMonth(0, 1);
        if (target.getDay() !== 4) {
            target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
        }
        return 1 + Math.ceil((firstThursday - target) / 604800000);
    }

    navigateWeek(direction) {
        const weekPicker = document.getElementById('week-picker');
        const currentWeek = weekPicker.value;
        
        if (!currentWeek) return;
        
        // Parse the current week (format: YYYY-WXX)
        const [year, weekStr] = currentWeek.split('-W');
        const currentWeekNum = parseInt(weekStr);
        
        // Calculate new week
        let newYear = parseInt(year);
        let newWeekNum = currentWeekNum + direction;
        
        // Handle year boundaries - use a more reliable week count
        const weeksInCurrentYear = this.getWeeksInYear(newYear);
        
        if (newWeekNum < 1) {
            newYear--;
            newWeekNum = this.getWeeksInYear(newYear);
        } else if (newWeekNum > weeksInCurrentYear) {
            newYear++;
            newWeekNum = 1;
        }
        
        // Update week picker and load data
        const newWeekString = `${newYear}-W${newWeekNum.toString().padStart(2, '0')}`;
        weekPicker.value = newWeekString;
        this.selectedWeek = newWeekString;
        this.loadData();
    }

    getWeeksInYear(year) {
        // Calculate number of weeks in a year more reliably
        // Most years have 52 weeks, some have 53
        const jan1 = new Date(year, 0, 1);
        const dec31 = new Date(year, 11, 31);
        
        // Check if January 1st is Thursday or if December 31st is Thursday in a leap year
        const jan1Day = jan1.getDay();
        const dec31Day = dec31.getDay();
        const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
        
        // Years have 53 weeks if Jan 1 is Thursday, or if it's a leap year and Jan 1 is Wednesday
        if (jan1Day === 4 || (isLeap && jan1Day === 3)) {
            return 53;
        }
        
        return 52;
    }

    async syncFromSalesforce() {
        const syncBtn = document.getElementById('sync-btn');
        const originalText = syncBtn.innerHTML;
        
        try {
            // Update button state
            syncBtn.disabled = true;
            syncBtn.classList.add('syncing');
            syncBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Syncing...';
            
            // Perform sync
            const response = await fetch('/api/sync', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const result = await response.json();
            
            // Show success message
            this.showSuccessMessage(`Synced ${result.count} opportunities from Salesforce`);
            
            // Reload data and sync status
            await this.loadData();
            await this.loadSyncStatus();
            
        } catch (error) {
            console.error('Sync error:', error);
            this.showError('Failed to sync from Salesforce. Please try again.');
        } finally {
            // Reset button state
            syncBtn.disabled = false;
            syncBtn.classList.remove('syncing');
            syncBtn.innerHTML = originalText;
        }
    }

    async loadSyncStatus() {
        try {
            const response = await fetch('/api/sync/status');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const status = await response.json();
            const syncStatusEl = document.getElementById('sync-status');
            const syncTextEl = document.getElementById('sync-text');
            
            if (status.hasData && status.lastSync) {
                const syncDate = new Date(status.lastSync.sync_timestamp);
                const timeAgo = this.getTimeAgo(syncDate);
                syncTextEl.textContent = `Last sync: ${timeAgo} (${status.lastSync.records_synced} records)`;
                syncStatusEl.classList.remove('hidden');
            } else {
                syncTextEl.textContent = 'Never synced';
                syncStatusEl.classList.remove('hidden');
            }
        } catch (error) {
            console.error('Failed to load sync status:', error);
        }
    }

    getTimeAgo(date) {
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        
        if (diffMins < 1) return 'just now';
        if (diffMins < 60) return `${diffMins} minutes ago`;
        if (diffHours < 24) return `${diffHours} hours ago`;
        if (diffDays < 7) return `${diffDays} days ago`;
        
        return date.toLocaleDateString();
    }

    showSuccessMessage(message) {
        // Prevent duplicate messages
        if (this.lastSuccessMessage === message) {
            return; // Don't show the same message twice
        }
        
        // Clear any existing timeout
        if (this.successMessageTimeout) {
            clearTimeout(this.successMessageTimeout);
        }
        
        // Remove any existing message
        const existingMessage = document.querySelector('.success-message');
        if (existingMessage) {
            existingMessage.remove();
        }
        
        // Store the current message to prevent duplicates
        this.lastSuccessMessage = message;
        
        // Create overlay success message in top-right corner
        const successDiv = document.createElement('div');
        successDiv.className = 'success-message overlay';
        successDiv.innerHTML = `
            <i class="fas fa-check-circle"></i>
            <span>${message}</span>
        `;
        
        // Add to body as overlay (doesn't move other elements)
        document.body.appendChild(successDiv);
        
        // Auto-remove after 2 seconds and reset duplicate prevention
        this.successMessageTimeout = setTimeout(() => {
            if (successDiv.parentNode) {
                successDiv.parentNode.removeChild(successDiv);
            }
            this.lastSuccessMessage = null; // Reset to allow same message later
        }, 2000);
    }

    // Manual Controls Methods
    async loadUserPreferences() {
        try {
            console.log('🔄 Loading user preferences from server...');
            const response = await fetch('/api/user-preferences');
            if (response.ok) {
                const preferences = await response.json();
                this.userPreferences = new Map();
                
                console.log('📥 Received preferences from server:', preferences.length, 'items');
                
                // Convert server data to Map format
                preferences.forEach(pref => {
                    this.userPreferences.set(pref.opportunity_id, {
                        fiveYardLine: Boolean(pref.five_yard_line),
                        priority: pref.priority_color,
                        intentLevel: pref.intent_level,
                        followUpDate: pref.follow_up_date,
                        positionX: pref.position_x,
                        positionY: pref.position_y
                    });
                    
                    if (pref.five_yard_line) {
                        console.log('🎯 Five-yard line opportunity found:', pref.opportunity_id);
                    }
                });
                
                console.log('✅ User preferences loaded successfully:', this.userPreferences.size, 'total');
            } else {
                console.warn('⚠️ Failed to load preferences:', response.status, response.statusText);
            }
        } catch (error) {
            console.error('❌ Failed to load user preferences:', error);
        }
    }

    saveUserPreferences(instantSync = false) {
        // For instant sync (drag operations), check rate limiting
        if (instantSync) {
            const now = Date.now();
            if (now - this.lastSyncTime >= this.minSyncInterval) {
                this.lastSyncTime = now;
                this.syncUserPreferencesToServer();
                return;
            } else {
                // Too soon for instant sync, fall back to timer
                this.hasPendingChanges = true;
            }
        }
        
        // Clear existing timer
        if (this.syncTimer) {
            clearTimeout(this.syncTimer);
        }
        
        // Set new timer for 15 seconds
        this.syncTimer = setTimeout(() => {
            this.syncUserPreferencesToServer();
        }, 15000);
        
        // Mark that we have pending changes
        this.hasPendingChanges = true;
    }

    async syncUserPreferencesToServer() {
        if (!this.hasPendingChanges && Date.now() - this.lastSyncTime < this.minSyncInterval) return;
        
        try {
            // Convert Map to array format for server
            const preferencesArray = Array.from(this.userPreferences.entries()).map(([opportunityId, prefs]) => ({
                opportunity_id: opportunityId,
                priority_color: prefs.priority || 'gray',
                intent_level: prefs.intentLevel || 5,
                five_yard_line: prefs.fiveYardLine || false,
                follow_up_date: prefs.followUpDate || null,
                position_x: prefs.positionX || null,
                position_y: prefs.positionY || null
            }));

            const response = await fetch('/api/user-preferences/bulk', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    user_id: 'default',
                    preferences: preferencesArray
                })
            });

            if (response.ok) {
                this.hasPendingChanges = false;
                this.lastSyncTime = Date.now();
                console.log('✅ User preferences synced to server (instant)');
            } else {
                console.error('❌ Failed to sync preferences to server');
            }
        } catch (error) {
            console.error('❌ Error syncing preferences to server:', error);
        }
    }

    // Force immediate sync (for important changes)
    async forceSyncUserPreferences() {
        if (this.syncTimer) {
            clearTimeout(this.syncTimer);
            this.syncTimer = null;
        }
        await this.syncUserPreferencesToServer();
    }

    saveOpportunityPreferences() {
        if (!this.currentOpportunity) return;
        
        const fiveYardLine = document.getElementById('modal-fiveyard-checkbox').checked;
        
        // Get priority from active button
        const activePriorityBtn = document.querySelector('.priority-btn.active');
        const priority = activePriorityBtn ? activePriorityBtn.dataset.priority : 'gray';
        
        // Get intent level from active button
        const activeIntentBtn = document.querySelector('.intent-btn.active');
        const intentLevel = activeIntentBtn ? parseInt(activeIntentBtn.dataset.intent) : 5;
        
        const followUpDate = document.getElementById('followup-date-picker').value;
        
        // Get existing preferences to preserve position data
        const existingPref = this.userPreferences.get(this.currentOpportunity.id) || {};
        
        // Only update position if intent level changed and we have a container
        let newPositionX = existingPref.positionX;
        let newPositionY = existingPref.positionY;
        
        if (existingPref.intentLevel !== intentLevel) {
            // Intent level changed, calculate new X position but keep Y position
            const container = document.getElementById('horizontal-cards');
            if (container) {
                const containerWidth = container.offsetWidth - 200;
                newPositionX = ((intentLevel - 1) / 9) * containerWidth;
                // Keep existing Y position or default to 20
                newPositionY = existingPref.positionY || 20;
            }
        }
        
        this.userPreferences.set(this.currentOpportunity.id, {
            fiveYardLine,
            priority,
            intentLevel,
            followUpDate: followUpDate || null,
            positionX: newPositionX,
            positionY: newPositionY
        });
        
        // Force immediate sync for critical modal changes
        this.forceSyncUserPreferences();
        
        // Save follow-up date to server if provided
        if (followUpDate) {
            this.saveFollowUpDate(this.currentOpportunity.id, followUpDate);
        }
        
        this.renderView(); // Re-render to apply changes
        this.closeModal();
        
        this.showSuccessMessage('Opportunity preferences updated!');
    }

    // Custom Smooth Drag System for Five-Yard View
    addDragEventListeners(card, opportunity) {
        let isDragging = false;
        let hasDragged = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let startX = 0;
        let startY = 0;
        let currentX = 0;
        let currentY = 0;
        let container = null;
        
        card.addEventListener('mousedown', (e) => {
            isDragging = true;
            hasDragged = false;
            this.isDragging = true;
            
            container = document.getElementById('horizontal-cards');
            const rect = container.getBoundingClientRect();
            const cardRect = card.getBoundingClientRect();
            
            // Store initial mouse position to detect actual dragging
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            
            startX = e.clientX - cardRect.left;
            startY = e.clientY - cardRect.top;
            
            card.classList.add('dragging');
            card.style.cursor = 'grabbing';
            card.style.zIndex = '1000';
            
            e.preventDefault();
        });
        
        document.addEventListener('mousemove', (e) => {
            if (!isDragging || !container) return;
            
            // Check if we've moved enough to be considered dragging
            const dragDistance = Math.sqrt(
                Math.pow(e.clientX - dragStartX, 2) + Math.pow(e.clientY - dragStartY, 2)
            );
            
            if (dragDistance > 5) { // 5px threshold
                hasDragged = true;
            }
            
            e.preventDefault();
            
            const containerRect = container.getBoundingClientRect();
            currentX = e.clientX - containerRect.left - startX;
            currentY = e.clientY - containerRect.top - startY;
            
            // Constrain to container bounds
            const maxX = container.offsetWidth - card.offsetWidth;
            const maxY = container.offsetHeight - card.offsetHeight;
            
            currentX = Math.max(0, Math.min(currentX, maxX));
            currentY = Math.max(0, Math.min(currentY, maxY));
            
            // Update position in real-time
            card.style.transform = `translate(${currentX}px, ${currentY}px)`;
            
            // Calculate and update intent level in real-time
            const containerWidth = container.offsetWidth - 200;
            const intentLevel = Math.max(1, Math.min(10, Math.round((currentX / containerWidth) * 9) + 1));
            
            // Update data attributes
            card.dataset.intentLevel = intentLevel;
            card.dataset.positionX = currentX;
            card.dataset.positionY = currentY;
            
            // Update preferences immediately with both X and Y coordinates
            const userPref = this.userPreferences.get(opportunity.id) || {};
            userPref.intentLevel = intentLevel;
            userPref.positionX = currentX;
            userPref.positionY = currentY;
            userPref.fiveYardLine = true; // Ensure five-yard flag stays set during drag
            this.userPreferences.set(opportunity.id, userPref);
        });
        
        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            
            isDragging = false;
            this.isDragging = false;
            
            card.classList.remove('dragging');
            card.style.cursor = 'grab';
            card.style.zIndex = '';
            
            // If we actually dragged, prevent click for a short time
            if (hasDragged) {
                // Mark as recently dragged to prevent click
                card.dataset.recentlyDragged = 'true';
                
                // Clear the flag after a short delay
                setTimeout(() => {
                    card.dataset.recentlyDragged = 'false';
                }, 200);
                
                // Ensure final drag state is saved with the correct intent level
                const finalIntentLevel = parseInt(card.dataset.intentLevel);
                const finalPositionX = parseFloat(card.dataset.positionX);
                const finalPositionY = parseFloat(card.dataset.positionY);
                
                const userPref = this.userPreferences.get(opportunity.id) || {};
                userPref.intentLevel = finalIntentLevel;
                userPref.positionX = finalPositionX;
                userPref.positionY = finalPositionY;
                userPref.fiveYardLine = true;
                this.userPreferences.set(opportunity.id, userPref);
                
                // Force immediate sync for drag operations
                this.forceSyncUserPreferences();
                
                // Show completion message
                this.showSuccessMessage(`Intent level: ${finalIntentLevel}`);
            } else {
                // No drag occurred, allow immediate clicking
                card.dataset.recentlyDragged = 'false';
            }
        });
    }

    initializeFiveYardDropZones() {
        const columns = document.querySelectorAll('#fiveyard-view .cards-container');
        
        columns.forEach(container => {
            container.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                container.classList.add('drag-over');
            });

            container.addEventListener('dragleave', (e) => {
                if (!container.contains(e.relatedTarget)) {
                    container.classList.remove('drag-over');
                }
            });

            container.addEventListener('drop', (e) => {
                e.preventDefault();
                container.classList.remove('drag-over');
                
                const opportunityId = e.dataTransfer.getData('text/plain');
                const targetStage = container.closest('.kanban-column').dataset.stage;
                
                this.moveOpportunityToStage(opportunityId, targetStage);
            });
        });
    }

    moveOpportunityToStage(opportunityId, targetStage) {
        // Find the opportunity in current data
        const opportunity = this.currentData.find(opp => opp.id === opportunityId);
        if (!opportunity) return;

        // Map target stage to proper stage names
        const stageMapping = {
            'engaged': 'Qualification',
            'fiveyard': 'Proposal/Quote',
            'closedwon': 'Closed Won'
        };

        const newStage = stageMapping[targetStage] || opportunity.stage;
        
        // Update the opportunity stage locally
        opportunity.stage = newStage;
        
        // Update user preferences if moving to five-yard
        if (targetStage === 'fiveyard') {
            const userPref = this.userPreferences.get(opportunityId) || {};
            userPref.fiveYardLine = true;
            this.userPreferences.set(opportunityId, userPref);
            this.saveUserPreferences(true); // Instant sync for five-yard positioning
        }
        
        // Re-render the view
        this.renderView();
        
        this.showSuccessMessage(`Moved opportunity to ${newStage}`);
    }

    // Optimized Horizontal Five-Yard View Methods
    positionCardHorizontally(card, opportunity) {
        const userPref = this.userPreferences.get(opportunity.id) || {};
        
        let positionX, positionY;
        
        // Check if we have saved coordinates
        if (userPref.positionX !== undefined && userPref.positionY !== undefined) {
            // Use saved exact positions
            positionX = userPref.positionX;
            positionY = userPref.positionY;
        } else {
            // First time placement - calculate from intent level
            const container = document.getElementById('horizontal-cards');
            if (!container) return;
            
            const intentLevel = userPref.intentLevel || 5; // Default to middle
            const containerWidth = container.offsetWidth - 200;
            positionX = ((intentLevel - 1) / 9) * containerWidth;
            positionY = 20; // Default vertical position
            
            // Save these initial positions
            userPref.positionX = positionX;
            userPref.positionY = positionY;
            userPref.fiveYardLine = true; // Ensure five-yard flag is set during initial positioning
            this.userPreferences.set(opportunity.id, userPref);
            this.saveUserPreferences(true); // Instant sync for initial positioning
        }
        
        // Apply the position
        card.style.transform = `translate(${positionX}px, ${positionY}px)`;
        card.style.position = 'absolute';
        
        // Store position data
        card.dataset.intentLevel = userPref.intentLevel || 5;
        card.dataset.positionX = positionX;
        card.dataset.positionY = positionY;
    }

    initializeHorizontalDropZone() {
        const container = document.getElementById('horizontal-cards');
        if (!container) return;
        
        const markers = document.querySelectorAll('.marker');
        
        // Make markers clickable to set intent level
        markers.forEach(marker => {
            marker.addEventListener('click', () => {
                const intentLevel = parseInt(marker.dataset.intent);
                this.showIntentLevelSelector(intentLevel);
            });
        });
        
        // Prevent default drag/select behavior on the container
        container.addEventListener('dragstart', (e) => {
            e.preventDefault();
        });
        
        container.addEventListener('selectstart', (e) => {
            e.preventDefault();
        });
    }

    updateOpportunityIntentDebounced(opportunityId, intentLevel) {
        // Temporarily remove debouncing to debug
        this.updateOpportunityIntent(opportunityId, intentLevel);
    }
    
    updateOpportunityIntent(opportunityId, intentLevel) {
        const userPref = this.userPreferences.get(opportunityId) || {};
        userPref.intentLevel = intentLevel;
        this.userPreferences.set(opportunityId, userPref);
        this.saveUserPreferences();
        
        // For now, use full re-render to ensure it works
        this.renderView();
        
        this.showSuccessMessage(`Updated intent level to ${intentLevel}`);
    }
    
    updateSingleCardPosition(opportunityId, intentLevel) {
        // Find the specific card and update its position only
        const card = document.querySelector(`[data-opportunity-id="${opportunityId}"]`);
        if (card) {
            // Ensure we have fresh container bounds
            const container = document.getElementById('horizontal-cards');
            if (container) {
                const containerWidth = container.offsetWidth - 200;
                const position = ((intentLevel - 1) / 9) * containerWidth;
                card.style.transform = `translate(${position}px, 20px)`;
                card.dataset.intentLevel = intentLevel;
                card.dataset.positionX = position;
            }
        } else {
            // Fallback to full re-render if card not found
            this.renderView();
        }
    }

    showIntentLevelSelector(intentLevel) {
        // For now, just show which level was clicked
        // This could be expanded to show a selector for moving specific opportunities
        this.showSuccessMessage(`Intent level ${intentLevel} selected`);
    }

    // Today Display and Follow-up Management
    updateTodayDisplay() {
        const today = new Date();
        const options = {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        };
        const todayString = today.toLocaleDateString('en-US', options);
        
        document.getElementById('today-date').textContent = `Today: ${todayString}`;
    }

    async saveFollowUpDate(opportunityId, followUpDate) {
        try {
            const response = await fetch(`/api/opportunities/${opportunityId}/followup`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ followUpDate })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            this.showSuccessMessage('Follow-up date saved!');
        } catch (error) {
            console.error('Error saving follow-up date:', error);
            this.showError('Failed to save follow-up date');
        }
    }

    async completeFollowUp() {
        if (!this.currentOpportunity) return;
        
        try {
            // Clear the follow-up date by setting it to null
            const response = await fetch(`/api/opportunities/${this.currentOpportunity.id}/followup`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ followUpDate: null })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            // Clear the follow-up date from user preferences as well
            const existingPref = this.userPreferences.get(this.currentOpportunity.id) || {};
            this.userPreferences.set(this.currentOpportunity.id, {
                ...existingPref,
                followUpDate: null
            });
            this.saveUserPreferences();
            
            // Clear the date picker
            document.getElementById('followup-date-picker').value = '';
            
            this.showSuccessMessage('Follow-up completed and cleared!');
            
            // Close modal and re-render view
            this.closeModal();
            this.renderView();
        } catch (error) {
            console.error('Error completing follow-up:', error);
            this.showError('Failed to complete follow-up');
        }
    }

    clearFollowUpDate() {
        if (!this.currentOpportunity) return;
        
        // Clear from user preferences
        const existingPref = this.userPreferences.get(this.currentOpportunity.id) || {};
        this.userPreferences.set(this.currentOpportunity.id, {
            ...existingPref,
            followUpDate: null
        });
        this.saveUserPreferences();
        
        // Clear the date picker
        document.getElementById('followup-date-picker').value = '';
        
        // Also clear from server
        this.saveFollowUpDate(this.currentOpportunity.id, null);
    }

    formatDateForInput(dateString) {
        if (!dateString) return '';
        const date = new Date(dateString);
        return date.toISOString().split('T')[0];
    }
}

// Initialize dashboard when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new SalesforceDashboard();
});

// Add some utility functions for debugging
window.dashboardDebug = {
    getCurrentData: function() {
        return window.dashboard?.currentData || [];
    },
    refreshData: function() {
        window.dashboard?.loadData();
    },
    switchView: function(view) {
        window.dashboard?.switchView(view);
    }
};
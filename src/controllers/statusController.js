import { createClient } from '@supabase/supabase-js';
import pool, { query } from '../db/neon.js';

// Initialize Clients Safely
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

export const getSystemStatus = async (req, res, next) => {
    try {
        // Core Services Definition
        const servicesDef = {
            api: { name: "VTX Backend API", type: 'compute' },
            supabase: { name: "Supabase (Core)", type: 'database' },
            neon: { name: "Neon (Logs)", type: 'database' },
            cloudinary: { name: "Cloudinary (Media)", type: 'storage' },
            firebase: { name: "Firebase (Realtime)", type: 'realtime' }
        };

        // Initialize Status Object
        const status = {
            system: {
                name: "CodeCrafts Ecosystem",
                environment: process.env.NODE_ENV || 'production',
                timestamp: new Date().toISOString(),
                global_status: 'operational'
            },
            services: {},
            incidents: []
        };

        const start = Date.now();

        // 1. Parallel Live Checks
        // We create a temporary map to hold live check results
        const liveResults = {};
        await Promise.all([
            checkSupabase().then(r => liveResults.supabase = r),
            checkNeon().then(r => liveResults.neon = r),
            checkCloudinary().then(r => liveResults.cloudinary = r),
            checkFirebase().then(r => liveResults.firebase = r),
            // API is always up if this code runs, but let's mock latency
            Promise.resolve({ status: 'operational', latency: 0 }).then(r => liveResults.api = r)
        ]);
        liveResults.api.latency = Date.now() - start;

        // 2. Fetch Incidents (Last 14 Days for logic, but we show 7)
        let rows = [];
        try {
            const result = await query(`
            SELECT * FROM system_incidents 
            WHERE created_at > NOW() - INTERVAL '14 days' 
            ORDER BY created_at DESC
        `);
            rows = result ? result.rows : [];
        } catch (e) {
            console.error("Failed to fetch incidents", e);
        }
        status.incidents = rows;

        // 3. Process History (Candles) & Final Status Override
        // Generate last 7 days dates (YYYY-MM-DD)
        const historyDates = Array.from({ length: 30 }, (_, i) => { // 30 days looks like a "bar chart"
            const d = new Date();
            d.setDate(d.getDate() - (29 - i));
            return d.toISOString().split('T')[0];
        });

        Object.keys(servicesDef).forEach(key => {
            const def = servicesDef[key];
            const live = liveResults[key] || { status: 'unknown', latency: 0 };

            // Check for ACTIVE incidents for this service
            const activeIncident = rows.find(i =>
                i.status !== 'resolved' &&
                (i.affected_service === key || i.affected_service === 'all')
            );

            // Override status if there is an active incident
            let finalStatus = live.status;
            if (activeIncident) {
                if (activeIncident.severity === 'critical') finalStatus = 'down';
                else if (activeIncident.severity === 'major') finalStatus = 'degraded';
                else if (activeIncident.severity === 'maintenance') finalStatus = 'maintenance';
                else finalStatus = 'degraded'; // minor
            }

            // Build History Bars
            const history = historyDates.map(dateStr => {
                // Find incidents on this day
                const dayIncidents = rows.filter(i => {
                    const iDate = new Date(i.created_at).toISOString().split('T')[0];
                    return iDate === dateStr &&
                        (i.affected_service === key || i.affected_service === 'all');
                });

                // Determine day color
                let dayStatus = 'operational';
                if (dayIncidents.some(i => i.severity === 'critical')) dayStatus = 'down';
                else if (dayIncidents.some(i => i.severity === 'major')) dayStatus = 'degraded';
                else if (dayIncidents.some(i => i.severity === 'minor')) dayStatus = 'degraded';

                return { date: dateStr, status: dayStatus };
            });

            status.services[key] = {
                ...def,
                status: finalStatus,
                latency: live.latency,
                history: history
            };
        });

        // 4. Determine Global Status
        const allStatuses = Object.values(status.services).map(s => s.status);
        if (allStatuses.includes('down')) status.system.global_status = 'major_outage';
        else if (allStatuses.includes('degraded')) status.system.global_status = 'degraded';
        else if (allStatuses.includes('maintenance')) status.system.global_status = 'maintenance';

        // Response
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); // Force fresh content
        if (req.accepts('html')) {
            if (req.originalUrl.includes('/admincenter') || req.path.includes('/admincenter')) {
                return res.send(renderAdminCenter(status));
            }
            return res.send(renderPublicPage(status));
        }
        return res.json(status);
    } catch (e) {
        // Pass async errors to Global Error Handler (app.js) instead of crashing
        next(e);
    }
};

// API to Create Incident
export const createIncident = async (req, res) => {
    const { title, description, severity, status, affected_service } = req.body;
    try {
        await query(
            `INSERT INTO system_incidents (title, description, severity, status, affected_service) VALUES ($1, $2, $3, $4, $5)`,
            [title, description, severity || 'minor', status || 'investigating', affected_service || 'all']
        );
        res.redirect('/vtx/2026/admincenter');
    } catch (e) {
        console.error("Incident Creation Failed", e);
        res.status(500).send("Failed to create incident: " + e.message);
    }
};

// Emergency Fix Route to Clear All Incidents
export const resolveAllIncidents = async (req, res) => {
    try {
        await query("UPDATE system_incidents SET status = 'resolved' WHERE status != 'resolved'");
        res.redirect('/vtx/2026/admincenter');
    } catch (e) {
        res.status(500).send("Failed: " + e.message);
    }
};

// --- Check Functions ---

// Timeout helper to prevent hanging checks
const withTimeout = (promise, ms = 3000) => {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms))
    ]);
};

async function checkSupabase() {
    if (!supabase) return { status: 'degraded', latency: 0, error: "Configuration Missing" };
    const start = Date.now();
    try {
        const { error } = await withTimeout(supabase.from('profiles').select('id').limit(1));
        if (error) throw error;
        return { status: 'operational', latency: Date.now() - start };
    } catch (e) {
        return { status: 'down', latency: Date.now() - start, error: e.message };
    }
}

async function checkNeon() {
    if (!pool) return { status: 'degraded', latency: 0, error: "Configuration Missing" };
    const start = Date.now();
    try {
        await withTimeout(pool.query('SELECT 1'));
        return { status: 'operational', latency: Date.now() - start };
    } catch (e) {
        return { status: 'down', latency: Date.now() - start, error: "Connection Failed" };
    }
}

async function checkCloudinary() {
    const start = Date.now();
    // Config check
    return { status: process.env.VITE_CLOUDINARY_CLOUD_NAME ? 'operational' : 'degraded', latency: Date.now() - start };
}

async function checkFirebase() {
    const start = Date.now();
    // Config check
    return { status: (process.env.FIREBASE_PROJECT_ID || process.env.VITE_ONESIGNAL_APP_ID) ? 'operational' : 'degraded', latency: Date.now() - start };
}


// --- Renderers ---

// --- Renderers ---

const renderPublicPage = (status) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CodeKrafts Status</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: Arial, sans-serif; }
    </style>
</head>
<body class="bg-gray-100 text-gray-900 min-h-screen flex flex-col items-center py-10 px-4">
    
    <!-- Branding -->
    <div class="mb-8 text-center">
        <h1 class="text-3xl font-bold mb-1">CodeKrafts Status</h1>
        <p class="text-gray-500 text-sm">System Operations</p>
    </div>

    <div class="max-w-3xl w-full space-y-6">
        
        <!-- Global Status -->
        <div class="bg-white rounded-lg border border-gray-200 p-6 flex items-center justify-between shadow-sm">
            <div>
                <h2 class="text-xl font-bold">Current Status</h2>
            </div>
            <div class="flex items-center gap-2 px-4 py-2 rounded-full ${status.system.global_status === 'operational' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">
                <span class="w-3 h-3 rounded-full ${status.system.global_status === 'operational' ? 'bg-green-500' : 'bg-red-500'}"></span>
                <span class="font-bold uppercase text-xs tracking-wider">${status.system.global_status.replace('_', ' ')}</span>
            </div>
        </div>

        <!-- Incidents Banner -->
        ${status.incidents.filter(i => i.status !== 'resolved').map(i => `
        <div class="bg-orange-50 border-l-4 border-orange-500 p-4 rounded shadow-sm">
            <h3 class="text-orange-900 font-bold">${i.title}</h3>
            <p class="text-orange-800 mt-1 text-sm">${i.description}</p>
            <p class="text-xs text-orange-600 mt-2 uppercase font-bold">${i.status} - ${new Date(i.updated_at).toLocaleString()}</p>
        </div>
        `).join('')}

        <!-- Services & Uptime Bars -->
        <div class="bg-white rounded-lg border border-gray-200 shadow-sm divide-y divide-gray-100">
            ${Object.values(status.services).map(s => `
            <div class="p-5">
                <div class="flex justify-between items-center mb-3">
                    <h3 class="font-bold text-gray-800">${s.name}</h3>
                    <span class="text-sm font-semibold ${s.status === 'operational' ? 'text-green-600' : 'text-red-500'}">
                        ${s.status === 'operational' ? 'Operational' : 'Issues'}
                    </span>
                </div>
                
                <!-- Uptime Candles (30 Days) -->
                <div class="flex gap-1 h-8 items-end">
                    ${s.history.map(day => `
                        <div class="flex-1 rounded-sm ${day.status === 'operational' ? 'bg-green-400' : (day.status === 'down' ? 'bg-red-500' : 'bg-orange-400')}"
                             title="${day.date}: ${day.status.toUpperCase()}"
                             style="height: 100%;">
                        </div>
                    `).join('')}
                </div>
                <div class="flex justify-between text-xs text-gray-400 mt-1">
                    <span>30 days ago</span>
                    <span>Today</span>
                </div>
            </div>
            `).join('')}
        </div>

        <!-- Past Incident History -->
        <div class="mt-8">
            <h3 class="text-xl font-bold mb-4">Past Incidents</h3>
             <div class="space-y-4">
                 ${status.incidents.filter(i => i.status === 'resolved').slice(0, 5).map(i => `
                    <div class="bg-white p-4 rounded-lg border border-gray-200">
                        <div class="flex justify-between items-start mb-1">
                            <h4 class="font-bold text-gray-800">${i.title}</h4>
                            <span class="text-xs text-gray-400">${new Date(i.created_at).toLocaleDateString()}</span>
                        </div>
                         <p class="text-gray-600 text-sm mb-2">${i.description}</p>
                         <span class="text-xs font-bold text-green-600 uppercase tracking-wider">Resolved</span>
                    </div>
                 `).join('')}
                 ${status.incidents.length === 0 ? '<p class="text-gray-400 italic">No recent incidents.</p>' : ''}
             </div>
        </div>

    </div>
</body>
</html>
`;


const renderAdminCenter = (status) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Center</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { font-family: Arial, sans-serif; }
    </style>
</head>
<body class="bg-gray-100 text-gray-900 min-h-screen p-6">
    <div class="max-w-7xl mx-auto space-y-6">
        
        <!-- Header -->
        <header class="flex justify-between items-center bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
            <div>
                <h1 class="text-2xl font-bold">CodeKrafts Admin</h1>
                <p class="text-gray-500 text-sm">Operations Dashboard</p>
            </div>
             <div class="text-right flex items-center gap-4">
                <a href="/vtx/2026/admincenter/resolve_all" class="bg-green-600 hover:bg-green-700 text-white text-xs font-bold py-2 px-4 rounded transition-colors uppercase tracking-wider">
                    Force System Online
                </a>
                <div>
                    <div class="text-xs font-bold text-gray-400 uppercase tracking-wider">System Status</div>
                    <div class="text-lg font-bold ${status.system.global_status === 'operational' ? 'text-green-600' : 'text-red-600'}">
                        ${status.system.global_status.toUpperCase()}
                    </div>
                </div>
            </div>
        </header>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            
            <!-- Left Col: Metrics -->
            <div class="lg:col-span-2 space-y-6">
                <!-- Latency Graph -->
                 <div class="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
                    <h3 class="text-lg font-bold mb-4">Live Latency</h3>
                    <div class="relative h-64 w-full">
                        <canvas id="latencyChart"></canvas>
                    </div>
                </div>

                <!-- Service List -->
                <div class="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
                    <table class="min-w-full divide-y divide-gray-200">
                        <thead class="bg-gray-50">
                            <tr>
                                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Service</th>
                                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Latency</th>
                            </tr>
                        </thead>
                        <tbody class="bg-white divide-y divide-gray-200">
                            ${Object.values(status.services).map(s => `
                            <tr>
                                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${s.name}</td>
                                <td class="px-6 py-4 whitespace-nowrap">
                                    <span class="px-2 inline-flex text-xs leading-5 font-bold rounded-full ${s.status === 'operational' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">
                                        ${s.status}
                                    </span>
                                </td>
                                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 text-right font-mono">${s.latency}ms</td>
                            </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Right Col: Actions -->
            <div class="space-y-6">
                
                <!-- Post Incident Form -->
                <div class="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
                    <h3 class="text-lg font-bold mb-4">Update Status</h3>
                    <form action="/vtx/2026/admincenter/incidents" method="POST" class="space-y-4">
                         <div>
                            <label class="block text-sm font-bold text-gray-700 mb-1">Affected Service</label>
                            <select name="affected_service" class="w-full bg-gray-50 border border-gray-300 rounded px-3 py-2 text-sm">
                                <option value="all">Global (All Services)</option>
                                <option value="api">VTX Backend API</option>
                                <option value="supabase">Supabase Core</option>
                                <option value="neon">Neon DB</option>
                                <option value="cloudinary">Cloudinary</option>
                                <option value="firebase">Firebase</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-sm font-bold text-gray-700 mb-1">Title</label>
                            <input type="text" name="title" required class="w-full bg-gray-50 border border-gray-300 rounded px-3 py-2 text-sm" placeholder="e.g. All Systems Operational">
                        </div>
                         <div>
                            <label class="block text-sm font-bold text-gray-700 mb-1">Description</label>
                            <textarea name="description" rows="3" class="w-full bg-gray-50 border border-gray-300 rounded px-3 py-2 text-sm" placeholder="Message..."></textarea>
                        </div>
                        <div class="grid grid-cols-2 gap-3">
                            <div>
                                <label class="block text-sm font-bold text-gray-700 mb-1">Severity</label>
                                <select name="severity" class="w-full bg-gray-50 border border-gray-300 rounded px-3 py-2 text-sm">
                                    <option value="minor">Minor</option>
                                    <option value="major">Major</option>
                                    <option value="critical">Critical</option>
                                    <option value="maintenance">Maintenance</option>
                                </select>
                            </div>
                            <div>
                                <label class="block text-sm font-bold text-gray-700 mb-1">Status</label>
                                <select name="status" class="w-full bg-gray-50 border border-gray-300 rounded px-3 py-2 text-sm">
                                    <option value="resolved">RESOLVED (Green)</option>
                                    <option value="investigating">Investigating (Red)</option>
                                    <option value="identified">Identified (Red)</option>
                                    <option value="monitoring">Monitoring (Red)</option>
                                </select>
                            </div>
                        </div>
                        <button type="submit" class="w-full bg-black hover:bg-gray-800 text-white font-bold py-3 rounded transition-colors">
                            Update Status
                        </button>
                    </form>
                </div>

                 <!-- Recent Updates List -->
                <div class="bg-white p-6 rounded-lg border border-gray-200 shadow-sm max-h-96 overflow-y-auto">
                    <h3 class="text-sm font-bold text-gray-500 uppercase tracking-wider mb-4">Recent Updates</h3>
                    <div class="space-y-4">
                        ${status.incidents.map(i => `
                            <div class="border-l-4 ${getSeverityColor(i.severity)} pl-3 py-1">
                                <div class="flex justify-between items-start">
                                    <h4 class="font-bold text-sm text-gray-800">${i.title}</h4>
                                    <span class="text-[10px] bg-gray-100 px-2 py-1 rounded text-gray-500">${new Date(i.created_at).toLocaleDateString()}</span>
                                </div>
                                <div class="text-xs text-gray-500 mt-1">Service: <span class="font-mono text-gray-700">${i.affected_service || 'all'}</span></div>
                                <span class="text-[10px] uppercase font-bold mt-2 inline-block ${i.status === 'resolved' ? 'text-green-600' : 'text-orange-600'}">
                                    ${i.status}
                                </span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const ctx = document.getElementById('latencyChart').getContext('2d');
        const labels = ['Api', 'Supabase', 'Neon', 'Media', 'Realtime'];
        const data = [
            ${status.services.api.latency},
            ${status.services.supabase.latency},
            ${status.services.neon.latency},
            ${status.services.cloudinary.latency},
            ${status.services.firebase.latency}
        ];

        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Latency (ms)',
                    data: data,
                    backgroundColor: '#000000',
                    borderRadius: 4
                }]
            },
            options: {
                scales: {
                    y: { beginAtZero: true },
                    x: { grid: { display: false } }
                },
                plugins: { legend: { display: false } }
            }
        });
    </script>
</body>
</html>
`;

function getSeverityColor(sev) {
    if (sev === 'critical') return 'border-red-500';
    if (sev === 'major') return 'border-orange-500';
    if (sev === 'minor') return 'border-yellow-500';
    return 'border-blue-500';
}
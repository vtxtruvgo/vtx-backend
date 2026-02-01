import { createClient } from '@supabase/supabase-js';
import pool, { query } from '../db/neon.js';

// Initialize Clients
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export const getSystemStatus = async (req, res) => {
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
            const dayIncidents = rows.filter(i =>
                i.created_at.startsWith(dateStr) &&
                (i.affected_service === key || i.affected_service === 'all')
            );

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
    if (req.accepts('html')) {
        if (req.originalUrl.includes('/admincenter') || req.path.includes('/admincenter')) {
            return res.send(renderAdminCenter(status));
        }
        return res.send(renderPublicPage(status));
    }
    return res.json(status);
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
        res.status(500).send("Failed to create incident: " + e.message);
    }
};

// --- Check Functions ---
async function checkSupabase() {
    const start = Date.now();
    try {
        const { error } = await supabase.from('profiles').select('id').limit(1);
        if (error) throw error;
        return { status: 'operational', latency: Date.now() - start };
    } catch (e) {
        return { status: 'down', latency: Date.now() - start, error: e.message };
    }
}

async function checkNeon() {
    const start = Date.now();
    try {
        await pool.query('SELECT 1');
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

const renderPublicPage = (status) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CodeCrafts Status</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; }
        h1, h2, h3 { font-family: 'Playfair Display', serif; }
        .bar-tooltip:hover::after {
            content: attr(title);
            position: absolute;
            bottom: 100%;
            left: 50%;
            transform: translateX(-50%);
            background: #333;
            color: white;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 10px;
            white-space: nowrap;
            margin-bottom: 4px;
            z-index: 10;
        }
    </style>
</head>
<body class="bg-gray-50 text-slate-900 min-h-screen flex flex-col items-center py-12 px-4">
    
    <!-- Branding -->
    <div class="mb-10 text-center">
        <h1 class="text-4xl font-bold text-slate-900 mb-2">CodeCrafts Status</h1>
        <p class="text-slate-500 font-medium">System Performance & Updates</p>
    </div>

    <div class="max-w-3xl w-full space-y-8">
        
        <!-- Global Status -->
        <div class="bg-white rounded border border-slate-200 p-6 flex items-center justify-between shadow-sm">
            <div>
                <h2 class="text-xl font-bold text-slate-800">Current Status</h2>
                <p class="text-sm text-slate-500 mt-1">Real-time status of all services</p>
            </div>
            <div class="flex items-center gap-2 px-4 py-2 rounded-full ${status.system.global_status === 'operational' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'} border ${status.system.global_status === 'operational' ? 'border-emerald-100' : 'border-red-100'}">
                <span class="w-3 h-3 rounded-full ${status.system.global_status === 'operational' ? 'bg-emerald-500' : 'bg-red-500'}"></span>
                <span class="font-bold uppercase text-xs tracking-wider">${status.system.global_status.replace('_', ' ')}</span>
            </div>
        </div>

        <!-- Incidents Banner -->
        ${status.incidents.filter(i => i.status !== 'resolved').map(i => `
        <div class="bg-orange-50 border-l-4 border-orange-500 p-4 rounded-r shadow-sm">
            <h3 class="text-orange-900 font-bold text-lg">${i.title}</h3>
            <p class="text-orange-800 mt-1">${i.description}</p>
            <p class="text-xs text-orange-600 mt-2 uppercase font-bold">${i.status} - ${new Date(i.updated_at).toLocaleString()}</p>
        </div>
        `).join('')}

        <!-- Services & Uptime Bars -->
        <div class="bg-white rounded border border-slate-200 shadow-sm divide-y divide-slate-100">
            ${Object.values(status.services).map(s => `
            <div class="p-6">
                <div class="flex justify-between items-center mb-4">
                    <h3 class="text-lg font-bold text-slate-800">${s.name}</h3>
                    <span class="text-sm font-medium ${s.status === 'operational' ? 'text-emerald-600' : 'text-red-500'}">
                        ${s.status === 'operational' ? 'Operational' : 'Issues'}
                    </span>
                </div>
                
                <!-- Uptime Candles (30 Days) -->
                <div class="flex gap-[2px] h-8 items-end">
                    ${s.history.map(day => `
                        <div class="flex-1 rounded-sm bar-tooltip relative ${day.status === 'operational' ? 'bg-emerald-400 opacity-90 hover:opacity-100' : (day.status === 'down' ? 'bg-red-500' : 'bg-amber-400')}"
                             title="${day.date}: ${day.status.toUpperCase()}"
                             style="height: ${day.status === 'operational' ? '100%' : '100%'}">
                        </div>
                    `).join('')}
                </div>
                <div class="flex justify-between text-xs text-slate-400 mt-2">
                    <span>30 days ago</span>
                    <span>Today</span>
                </div>
            </div>
            `).join('')}
        </div>

        <!-- Past Incident History -->
        <div class="mt-12">
            <h3 class="text-2xl font-bold text-slate-900 mb-6">Past Incidents</h3>
             <div class="space-y-4">
                 ${status.incidents.filter(i => i.status === 'resolved').slice(0, 5).map(i => `
                    <div class="bg-white p-6 rounded border border-slate-200">
                        <div class="flex justify-between items-start mb-2">
                            <h4 class="text-lg font-bold text-slate-800">${i.title}</h4>
                            <span class="text-xs text-slate-400">${new Date(i.created_at).toLocaleDateString()}</span>
                        </div>
                         <p class="text-slate-600 mb-3">${i.description}</p>
                         <span class="text-xs font-bold text-emerald-600 uppercase tracking-wider">Resolved</span>
                    </div>
                 `).join('')}
                 ${status.incidents.length === 0 ? '<p class="text-slate-400 italic">No incidents reported in the last 14 days.</p>' : ''}
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
    <title>VTX Admin Center</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; }
        h1, h2, h3, h4 { font-family: 'Playfair Display', serif; }
    </style>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen p-6">
    <div class="max-w-7xl mx-auto space-y-6">
        
        <!-- Header -->
        <header class="flex justify-between items-center bg-white p-6 rounded border border-slate-200 shadow-sm">
            <div>
                <h1 class="text-2xl font-bold text-slate-800">VTX Admin Center</h1>
                <p class="text-slate-500 text-sm">Operations & Incident Management</p>
            </div>
             <div class="text-right">
                <div class="text-xs font-bold text-slate-400 uppercase tracking-wider">System Status</div>
                <div class="text-lg font-bold ${status.system.global_status === 'operational' ? 'text-emerald-600' : 'text-red-600'}">
                    ${status.system.global_status.toUpperCase()}
                </div>
            </div>
        </header>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            
            <!-- Left Col: Metrics -->
            <div class="lg:col-span-2 space-y-6">
                <!-- Latency Graph (Classic Line) -->
                 <div class="bg-white p-6 rounded border border-slate-200 shadow-sm">
                    <h3 class="text-lg font-bold text-slate-800 mb-4">Live Latency Metrics</h3>
                    <div class="relative h-64 w-full">
                        <canvas id="latencyChart"></canvas>
                    </div>
                </div>

                <!-- Service List -->
                <div class="bg-white rounded border border-slate-200 shadow-sm overflow-hidden">
                    <table class="min-w-full divide-y divide-slate-200">
                        <thead class="bg-slate-50">
                            <tr>
                                <th class="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Service</th>
                                <th class="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Status</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">Latency</th>
                            </tr>
                        </thead>
                        <tbody class="bg-white divide-y divide-slate-200">
                            ${Object.values(status.services).map(s => `
                            <tr>
                                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-900">${s.name}</td>
                                <td class="px-6 py-4 whitespace-nowrap">
                                    <span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${s.status === 'operational' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}">
                                        ${s.status}
                                    </span>
                                </td>
                                <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-500 text-right text-mono font-mono">${s.latency}ms</td>
                            </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Right Col: Actions -->
            <div class="space-y-6">
                
                <!-- Post Incident Form -->
                <div class="bg-white p-6 rounded border border-slate-200 shadow-sm">
                    <h3 class="text-lg font-bold text-slate-800 mb-4">Post Global Update</h3>
                    <form action="/vtx/2026/admincenter/incidents" method="POST" class="space-y-4">
                         <div>
                            <label class="block text-sm font-semibold text-slate-700 mb-1">Affected Service</label>
                            <select name="affected_service" class="w-full bg-slate-50 border border-slate-300 rounded px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500">
                                <option value="all">Global (All Services)</option>
                                <option value="api">VTX Backend API</option>
                                <option value="supabase">Supabase Core</option>
                                <option value="neon">Neon DB</option>
                                <option value="cloudinary">Cloudinary</option>
                                <option value="firebase">Firebase</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-sm font-semibold text-slate-700 mb-1">Title</label>
                            <input type="text" name="title" required class="w-full bg-slate-50 border border-slate-300 rounded px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" placeholder="e.g. Database Performance Degradation">
                        </div>
                         <div>
                            <label class="block text-sm font-semibold text-slate-700 mb-1">Description</label>
                            <textarea name="description" rows="5" class="w-full bg-slate-50 border border-slate-300 rounded px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" placeholder="Detailed explanation..."></textarea>
                        </div>
                        <div class="grid grid-cols-2 gap-3">
                            <div>
                                <label class="block text-sm font-semibold text-slate-700 mb-1">Severity</label>
                                <select name="severity" class="w-full bg-slate-50 border border-slate-300 rounded px-3 py-2 text-sm">
                                    <option value="minor">Minor Issue</option>
                                    <option value="major">Major Outage</option>
                                    <option value="critical">Critical Failure</option>
                                    <option value="maintenance">Maintenance</option>
                                </select>
                            </div>
                            <div>
                                <label class="block text-sm font-semibold text-slate-700 mb-1">Status</label>
                                <select name="status" class="w-full bg-slate-50 border border-slate-300 rounded px-3 py-2 text-sm">
                                    <option value="investigating">Investigating</option>
                                    <option value="identified">Identified</option>
                                    <option value="monitoring">Monitoring</option>
                                    <option value="resolved">Resolved</option>
                                </select>
                            </div>
                        </div>
                        <button type="submit" class="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-3 rounded transition-colors shadow-md">
                            Post Incident
                        </button>
                    </form>
                </div>

                 <!-- Recent Updates List -->
                <div class="bg-white p-6 rounded border border-slate-200 shadow-sm max-h-96 overflow-y-auto">
                    <h3 class="text-sm font-bold text-slate-500 uppercase tracking-wider mb-4">Operations Log</h3>
                    <div class="space-y-4">
                        ${status.incidents.map(i => `
                            <div class="border-l-2 ${getSeverityColor(i.severity)} pl-4 py-1">
                                <div class="flex justify-between items-start">
                                    <h4 class="font-bold text-sm text-slate-800">${i.title}</h4>
                                    <span class="text-[10px] bg-slate-100 px-2 py-1 rounded text-slate-500">${new Date(i.created_at).toLocaleDateString()}</span>
                                </div>
                                <div class="text-xs text-slate-500 mt-1">Service: <span class="font-mono text-slate-700">${i.affected_service || 'all'}</span></div>
                                <span class="text-[10px] uppercase font-bold mt-2 inline-block ${i.status === 'resolved' ? 'text-emerald-600' : 'text-amber-600'}">
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
        // Init Chart (Classical Line Style)
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
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Latency (ms)',
                    data: data,
                    backgroundColor: 'rgba(51, 65, 85, 0.1)',
                    borderColor: 'rgb(51, 65, 85)',
                    borderWidth: 2,
                    pointBackgroundColor: 'rgb(51, 65, 85)',
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                scales: {
                    y: { beginAtZero: true, grid: { color: 'rgba(0, 0, 0, 0.05)' } },
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
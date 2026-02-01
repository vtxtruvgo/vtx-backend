import { createClient } from '@supabase/supabase-js';
import pool, { query } from '../db/neon.js';

// Initialize Clients
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export const getSystemStatus = async (req, res) => {
    // Determine View Mode
    const isAdmin = req.path.includes('/admin') || req.path.includes('/unused-path'); // Logic handled by router basically

    // Core Status Object
    const status = {
        system: {
            name: "CodeCrafts Ecosystem",
            environment: process.env.NODE_ENV || 'production',
            timestamp: new Date().toISOString(),
            global_status: 'operational'
        },
        services: {
            api: { name: "VTX Backend API", status: 'operational', latency: 0, type: 'compute' },
            supabase: { name: "Supabase (Core)", status: 'checking', latency: 0, type: 'database' },
            neon: { name: "Neon (Logs)", status: 'checking', latency: 0, type: 'database' },
            cloudinary: { name: "Cloudinary (Media)", status: 'checking', latency: 0, type: 'storage' },
            firebase: { name: "Firebase (Realtime)", status: 'checking', latency: 0, type: 'realtime' }
        },
        incidents: []
    };

    const start = Date.now();

    // Parallel Checks
    await Promise.all([
        checkSupabase(status.services.supabase),
        checkNeon(status.services.neon),
        checkCloudinary(status.services.cloudinary),
        checkFirebase(status.services.firebase)
    ]);

    // Fetch Incidents (Neon)
    try {
        const { rows } = await query(`
            SELECT * FROM system_incidents 
            WHERE created_at > NOW() - INTERVAL '7 days' 
            ORDER BY created_at DESC
        `);
        status.incidents = rows || [];
    } catch (e) {
        console.error("Failed to fetch incidents", e);
    }

    status.services.api.latency = Date.now() - start;

    // Determine Global Status logic based on active critical incidents
    const criticalIncidents = status.incidents.filter(i => i.status !== 'resolved' && i.severity === 'critical');
    if (criticalIncidents.length > 0) status.system.global_status = 'major_outage';
    else {
        const allStatuses = Object.values(status.services).map(s => s.status);
        if (allStatuses.includes('down')) status.system.global_status = 'major_outage';
        else if (allStatuses.includes('degraded')) status.system.global_status = 'degraded';
    }

    // Response
    if (req.accepts('html')) {
        // Determine which template to render
        if (req.originalUrl.includes('/admincenter') || req.path.includes('/admincenter')) {
            return res.send(renderAdminCenter(status));
        }
        return res.send(renderPublicPage(status));
    }
    return res.json(status);
};

// API to Create Incident
export const createIncident = async (req, res) => {
    const { title, description, severity, status } = req.body;
    try {
        await query(
            `INSERT INTO system_incidents (title, description, severity, status) VALUES ($1, $2, $3, $4)`,
            [title, description, severity || 'minor', status || 'investigating']
        );
        res.redirect('/vtx/2026/admincenter'); // Redirect back to admin
    } catch (e) {
        res.status(500).send("Failed to create incident: " + e.message);
    }
};


// --- Check Functions (Same as before) ---
async function checkSupabase(service) {
    const start = Date.now();
    try {
        const { error } = await supabase.from('profiles').select('id').limit(1);
        if (error) throw error;
        service.status = 'operational';
    } catch (e) {
        service.status = 'down';
        service.error = e.message;
    }
    service.latency = Date.now() - start;
}

async function checkNeon(service) {
    const start = Date.now();
    try {
        await pool.query('SELECT 1');
        service.status = 'operational';
    } catch (e) {
        service.status = 'down';
        service.error = "Connection Failed";
    }
    service.latency = Date.now() - start;
}

async function checkCloudinary(service) {
    const start = Date.now();
    if (process.env.VITE_CLOUDINARY_CLOUD_NAME) {
        service.status = 'operational';
    } else {
        service.status = 'degraded';
    }
    service.latency = Date.now() - start;
}

async function checkFirebase(service) {
    const start = Date.now();
    if (process.env.FIREBASE_PROJECT_ID || process.env.VITE_ONESIGNAL_APP_ID) {
        service.status = 'operational';
    } else {
        service.status = 'degraded';
    }
    service.latency = Date.now() - start;
}


const renderPublicPage = (status) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CodeCrafts Status</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
    <style>body { font-family: 'Inter', sans-serif; }</style>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen flex flex-col items-center justify-center p-4">
    <div class="max-w-xl w-full text-center mb-8">
        <h1 class="text-3xl font-extrabold tracking-tight text-slate-900">System Status</h1>
        <div class="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-full ${status.system.global_status === 'operational' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'} font-bold">
            <span class="relative flex h-3 w-3">
              <span class="animate-ping absolute inline-flex h-full w-full rounded-full ${status.system.global_status === 'operational' ? 'bg-green-400' : 'bg-red-400'} opacity-75"></span>
              <span class="relative inline-flex rounded-full h-3 w-3 ${status.system.global_status === 'operational' ? 'bg-green-500' : 'bg-red-500'}"></span>
            </span>
            ${status.system.global_status === 'operational' ? 'All Systems Operational' : 'Systems Degraded'}
        </div>
    </div>

    <!-- Active Incidents Banner -->
    ${status.incidents.filter(i => i.status !== 'resolved').map(i => `
    <div class="max-w-xl w-full bg-orange-50 border-l-4 border-orange-500 p-4 mb-6 rounded shadow-sm">
        <div class="flex items-start">
            <div class="flex-shrink-0">
                <svg class="h-5 w-5 text-orange-400" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
            </div>
            <div class="ml-3">
                <h3 class="text-sm leading-5 font-medium text-orange-800">${i.title}</h3>
                <div class="mt-2 text-sm leading-5 text-orange-700"><p>${i.description}</p></div>
            </div>
        </div>
    </div>
    `).join('')}

    <div class="max-w-xl w-full bg-white rounded-2xl shadow-xl overflow-hidden border border-slate-100">
        <div class="divide-y divide-slate-100">
            ${Object.values(status.services).map(s => `
            <div class="p-5 flex items-center justify-between hover:bg-slate-50 transition-colors">
                <div class="flex items-center gap-4">
                    <div class="w-10 h-10 rounded-full flex items-center justify-center ${s.status === 'operational' ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'}">
                        ${getIcon(s.type)}
                    </div>
                    <div>
                        <h3 class="font-semibold text-slate-800">${s.name}</h3>
                        <p class="text-xs text-slate-400">${s.type.toUpperCase()}</p>
                    </div>
                </div>
                 <span class="text-sm font-medium ${s.status === 'operational' ? 'text-green-600' : 'text-red-500'}">
                    ${s.status === 'operational' ? 'Operational' : 'Issues Detected'}
                </span>
            </div>
            `).join('')}
        </div>
         <div class="bg-slate-50 px-6 py-4 text-center border-t border-slate-100">
             <p class="text-xs text-slate-400">Incident History (7 Days)</p>
             <div class="mt-2 space-y-2">
                 ${status.incidents.filter(i => i.status === 'resolved').slice(0, 3).map(i => `
                    <div class="text-xs flex justify-between text-slate-500">
                        <span>${i.title}</span>
                         <span class="text-green-600">Resolved</span>
                    </div>
                 `).join('')}
                 ${status.incidents.length === 0 ? '<span class="text-xs text-slate-300">No incidents in past week.</span>' : ''}
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
    <title>VTX Admin Center 2026</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Inter:wght@400;600&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; }
        .mono { font-family: 'JetBrains Mono', monospace; }
    </style>
</head>
<body class="bg-gray-900 text-gray-100 min-h-screen p-6">
    <div class="max-w-7xl mx-auto space-y-6">
        
        <!-- Header -->
        <header class="flex justify-between items-center bg-gray-800 p-6 rounded-xl border border-gray-700">
            <div>
                <h1 class="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-emerald-400">VTX Admin Center 2026</h1>
                <p class="text-gray-400 text-sm">Realtime Network Operations Center</p>
            </div>
             <div class="flex items-center gap-4">
                <div class="text-right">
                    <div class="text-xs font-bold text-gray-500 uppercase">System Status</div>
                    <div class="text-xl font-bold ${status.system.global_status === 'operational' ? 'text-emerald-500' : 'text-red-500'}">
                        ${status.system.global_status.toUpperCase()}
                    </div>
                </div>
            </div>
        </header>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            
            <!-- Left Col: Metrics & Charts -->
            <div class="lg:col-span-2 space-y-6">
                <!-- Service Grid -->
                <div class="grid grid-cols-2 md:grid-cols-3 gap-4">
                     ${Object.values(status.services).map(s => `
                    <div class="bg-gray-800 p-4 rounded-xl border border-gray-700 flex justify-between items-center">
                        <div>
                             <h3 class="text-sm font-semibold text-gray-300">${s.name}</h3>
                             <p class="text-xs text-gray-500 mt-1">${s.latency}ms latency</p>
                        </div>
                        <div class="w-3 h-3 rounded-full ${s.status === 'operational' ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]'}"></div>
                    </div>
                    `).join('')}
                </div>

                <!-- Graphs -->
                <div class="bg-gray-800 p-6 rounded-xl border border-gray-700">
                    <h3 class="text-lg font-bold mb-4">Live Latency Metrics</h3>
                    <div class="relative h-64 w-full">
                        <canvas id="latencyChart"></canvas>
                    </div>
                </div>
            </div>

            <!-- Right Col: Incident Management -->
            <div class="space-y-6">
                
                <!-- Post Incident Form -->
                <div class="bg-gray-800 p-6 rounded-xl border border-gray-700">
                    <h3 class="text-lg font-bold mb-4 flex items-center gap-2">
                        <svg class="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                        Report Incident
                    </h3>
                    <form action="/vtx/2026/admincenter/incidents" method="POST" class="space-y-3">
                        <div>
                            <label class="block text-xs font-semibold text-gray-400 mb-1">Title</label>
                            <input type="text" name="title" required class="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                        </div>
                         <div>
                            <label class="block text-xs font-semibold text-gray-400 mb-1">Description</label>
                            <textarea name="description" rows="3" class="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"></textarea>
                        </div>
                        <div class="grid grid-cols-2 gap-3">
                            <div>
                                <label class="block text-xs font-semibold text-gray-400 mb-1">Severity</label>
                                <select name="severity" class="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm">
                                    <option value="minor">Minor</option>
                                    <option value="major">Major</option>
                                    <option value="critical">Critical</option>
                                    <option value="maintenance">Maintenance</option>
                                </select>
                            </div>
                            <div>
                                <label class="block text-xs font-semibold text-gray-400 mb-1">Status</label>
                                <select name="status" class="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm">
                                    <option value="investigating">Investigating</option>
                                    <option value="identified">Identified</option>
                                    <option value="monitoring">Monitoring</option>
                                    <option value="resolved">Resolved</option>
                                </select>
                            </div>
                        </div>
                        <button type="submit" class="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-2 rounded transition-colors shadow-lg shadow-red-900/50">
                            Post Incident
                        </button>
                    </form>
                </div>

                <!-- Recent Incidents -->
                <div class="bg-gray-800 p-6 rounded-xl border border-gray-700 max-h-96 overflow-y-auto">
                    <h3 class="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">Past 7 Days</h3>
                    <div class="space-y-4">
                        ${status.incidents.map(i => `
                            <div class="border-l-2 ${getSeverityColor(i.severity)} pl-3 py-1">
                                <div class="flex justify-between items-start">
                                    <h4 class="font-bold text-sm text-gray-200">${i.title}</h4>
                                    <span class="text-[10px] bg-gray-700 px-1.5 py-0.5 rounded text-gray-300">${new Date(i.created_at).toLocaleDateString()}</span>
                                </div>
                                <p class="text-xs text-gray-400 mt-1 line-clamp-2">${i.description}</p>
                                <span class="text-[10px] uppercase font-bold mt-2 inline-block ${i.status === 'resolved' ? 'text-green-500' : 'text-yellow-500'}">
                                    ${i.status}
                                </span>
                            </div>
                        `).join('')}
                        ${status.incidents.length === 0 ? '<p class="text-xs text-gray-500 italic">No recent incidents recorded.</p>' : ''}
                    </div>
                </div>

            </div>
        </div>
    </div>

    <script>
        // Init Chart
        const ctx = document.getElementById('latencyChart').getContext('2d');
        const labels = ['Api', 'Supabase', 'Neon', 'Cloudinary', 'Firebase'];
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
                    backgroundColor: [
                        'rgba(59, 130, 246, 0.6)',
                        'rgba(16, 185, 129, 0.6)',
                        'rgba(236, 72, 153, 0.6)',
                        'rgba(245, 158, 11, 0.6)',
                        'rgba(139, 92, 246, 0.6)'
                    ],
                    borderColor: [
                        'rgb(59, 130, 246)',
                        'rgb(16, 185, 129)',
                        'rgb(236, 72, 153)',
                        'rgb(245, 158, 11)',
                        'rgb(139, 92, 246)'
                    ],
                    borderWidth: 1
                }]
            },
            options: {
                scales: {
                    y: { beginAtZero: true, grid: { color: 'rgba(255, 255, 255, 0.1)' } },
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

function getIcon(type) {
    // Use same icon logic as before, just inline for concise output or imported if module split
    if (type === 'database') return `<svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" /></svg>`;
    if (type === 'compute') return `<svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>`;
    if (type === 'storage') return `<svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" /></svg>`;
    if (type === 'realtime') return `<svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 5l7 7-7 7M5 5l7 7-7 7" /></svg>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`;
}
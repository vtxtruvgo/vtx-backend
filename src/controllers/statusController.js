import { createClient } from '@supabase/supabase-js';
import pool from '../db/neon.js';

// Initialize Supabase Client
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export const getSystemStatus = async (req, res) => {
    const status = {
        api: { status: 'operational', latency: 0 },
        supabase: { status: 'checking', latency: 0 }, // Main DB
        neon: { status: 'checking', latency: 0 },     // Logs DB
        ai_service: { status: 'operational' },        // VTX Backend Logic
        timestamp: new Date().toISOString()
    };

    const start = Date.now();

    try {
        // 1. Check Supabase (Main DB)
        const sbStart = Date.now();
        const { error: sbError } = await supabase.from('profiles').select('id').limit(1);
        status.supabase.latency = Date.now() - sbStart;
        status.supabase.status = sbError ? 'degraded' : 'operational';
        if (sbError) status.supabase.message = sbError.message;
    } catch (e) {
        status.supabase.status = 'down';
        status.supabase.message = e.message;
    }

    try {
        // 2. Check Neon (Logs DB)
        const neonStart = Date.now();
        await pool.query('SELECT 1'); // Simple ping
        status.neon.latency = Date.now() - neonStart;
        status.neon.status = 'operational';
    } catch (e) {
        status.neon.status = 'down';
        status.neon.message = "Connectivity Error"; // Hide raw error for security
        console.error("Neon Status Error:", e);
    }

    status.api.latency = Date.now() - start;

    // Return HTML if requested
    if (req.query.format === 'html' || req.accepts('html')) {
        return res.send(renderStatusPage(status));
    }

    // Default JSON
    return res.json(status);
};

const renderStatusPage = (status) => {
    const getBadgeInfo = (s) => {
        if (s === 'operational') return { color: 'bg-green-500', text: 'Operational' };
        if (s === 'degraded') return { color: 'bg-yellow-500', text: 'Degraded' };
        return { color: 'bg-red-500', text: 'Down' };
    };

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CodeCrafts System Status</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>body { font-family: 'Inter', sans-serif; }</style>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen flex items-center justify-center p-4">
    <div class="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden">
        <div class="bg-blue-600 p-6 text-center">
            <h1 class="text-2xl font-bold text-white">System Status</h1>
            <p class="text-blue-100 text-sm mt-1">All Systems Check</p>
        </div>
        
        <div class="p-6 space-y-4">
            <!-- API -->
            <div class="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-100">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600">
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                    </div>
                    <div>
                        <h3 class="font-semibold text-sm">Main API</h3>
                        <p class="text-xs text-gray-500">vtx-backend</p>
                    </div>
                </div>
                <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                    Operational
                </span>
            </div>

            <!-- Supabase -->
            <div class="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-100">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600">
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" /></svg>
                    </div>
                    <div>
                        <h3 class="font-semibold text-sm">Supabase</h3>
                        <p class="text-xs text-gray-500">Core Data • ${status.supabase.latency}ms</p>
                    </div>
                </div>
                <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${status.supabase.status === 'operational' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">
                    ${status.supabase.status}
                </span>
            </div>

            <!-- Neon -->
            <div class="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-100">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full bg-pink-100 flex items-center justify-center text-pink-600">
                         <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                    </div>
                    <div>
                        <h3 class="font-semibold text-sm">Neon DB</h3>
                        <p class="text-xs text-gray-500">Logs & Analytics • ${status.neon.latency}ms</p>
                    </div>
                </div>
                <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${status.neon.status === 'operational' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">
                    ${status.neon.status}
                </span>
            </div>

        </div>
        <div class="bg-gray-50 px-6 py-3 text-center border-t border-gray-100">
            <p class="text-xs text-gray-400">CodeCrafts by Truvgo • Status as of ${new Date().toLocaleTimeString()}</p>
        </div>
    </div>
</body>
</html>
    `;
};
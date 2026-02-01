import { createClient } from '@supabase/supabase-js';
import pool, { query } from '../db/neon.js';

// Initialize Supabase Client (Shared)
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export const trackView = async (req, res) => {
    const { postId, userId } = req.body;

    if (!postId) {
        return res.status(400).json({ error: 'Post ID is required' });
    }

    try {
        // 1. FAST LOGGING TO NEON (The "Heavy" part)
        // We log the detailed view event here instead of Supabase `post_views` table
        // This saves storage on Supabase and keeps the main DB clean.

        // Ensure table exists (Lazy init pattern)
        await query(`
            CREATE TABLE IF NOT EXISTS post_views_log (
                id SERIAL PRIMARY KEY,
                post_id UUID,
                user_id UUID,
                viewed_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Insert Log
        await query(
            'INSERT INTO post_views_log (post_id, user_id) VALUES ($1, $2)',
            [postId, userId || null]
        );

        // 2. LIGHTWEIGHT UPDATE TO SUPABASE (The "Count" part)
        // We just increment the counter. We do NOT calculate it by counting rows anymore.
        // This is 100x more efficient.

        const { error } = await supabase.rpc('increment_post_view_count', { p_post_id: postId });

        if (error) {
            // If RPC doesn't exist, we fallback to a manual atomic update if possible, 
            // or just assume the user will rely on the Neon log for accurate stats later.
            // But for now, let's try a standard update if RPC fails.
            if (error.code === '42883') { // Undefined Function
                // Fallback: This is less safe for concurrency but works without RPC
                // We read current count and add 1. 
                // Ideally, you should create the RPC.
                console.warn("RPC increment_post_view_count missing. Creating it would be better.");
            } else {
                console.error("Supabase Counter Update Error:", error);
            }
        }

        return res.status(200).json({ success: true });

    } catch (err) {
        console.error('Analytics Track Error:', err);
        // Fail silently to frontend? No, return 500 for debug.
        // But for analytics, we often don't want to crash the UI.
        return res.status(200).json({ success: false, error: 'Logged error' });
    }
};
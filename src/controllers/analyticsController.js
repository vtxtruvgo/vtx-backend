import { createClient } from '@supabase/supabase-js';
import pool, { query } from '../db/neon.js';

// Initialize Supabase Client (For lightweight queries only - profiles/posts CRUD)
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export const trackView = async (req, res) => {
    const { postId, userId } = req.body;

    if (!postId) {
        return res.status(400).json({ error: 'Post ID is required' });
    }

    try {
        // FAST LOGGING TO NEON
        await query(`
            CREATE TABLE IF NOT EXISTS post_views_log (
                id SERIAL PRIMARY KEY,
                post_id UUID,
                user_id UUID,
                viewed_at TIMESTAMP DEFAULT NOW()
            )
        `);

        await query(
            'INSERT INTO post_views_log (post_id, user_id) VALUES ($1, $2)',
            [postId, userId || null]
        );

        // Update Supabase counter (lightweight)
        const { error } = await supabase.rpc('increment_post_view_count', { p_post_id: postId });

        if (error && error.code !== '42883') {
            console.error("Supabase Counter Update Error:", error);
        }

        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('Analytics Track Error:', err);
        return res.status(200).json({ success: false, error: 'Logged error' });
    }
};

// ============================================================================
// Analytics Dashboard Endpoints - Using NeonDB (Primary) + Supabase (Fallback)
// ============================================================================

export const getOverviewStats = async (req, res) => {
    try {
        // Try NeonDB cache first
        const cacheQuery = `
            SELECT metric_name, metric_value 
            FROM analytics_stats_cache 
            WHERE metric_name IN ('total_users', 'total_posts', 'total_likes', 'total_comments', 'total_revenue', 'new_users_24h')
        `;

        const result = await query(cacheQuery);

        if (result && result.rows && result.rows.length > 0) {
            // Convert rows to object
            const stats = {};
            result.rows.forEach(row => {
                const key = row.metric_name.replace(/_([a-z])/g, (g) => g[1].toUpperCase()).replace('_', '');
                stats[key] = parseInt(row.metric_value) || 0;
            });

            // Calculate total interactions
            stats.totalInteractions = (stats.totalLikes || 0) + (stats.totalComments || 0);

            return res.status(200).json({
                totalUsers: stats.totalUsers || 0,
                totalPosts: stats.totalPosts || 0,
                totalInteractions: stats.totalInteractions || 0,
                totalRevenue: stats.totalRevenue || 0,
                newUsers24h: stats.newUsers24h || 0
            });
        }

        // Fallback to Supabase if Neon cache is empty
        console.log('📊 Neon cache empty, falling back to Supabase...');
        const { count: totalUsers } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
        const { count: totalPosts } = await supabase.from('posts').select('*', { count: 'exact', head: true });
        const { count: totalLikes } = await supabase.from('likes').select('*', { count: 'exact', head: true });
        const { count: totalComments } = await supabase.from('comments').select('*', { count: 'exact', head: true });

        const { data: revenueData } = await supabase
            .from('ad_credit_requests')
            .select('amount')
            .eq('status', 'approved');

        const totalRevenue = revenueData?.reduce((sum, r) => sum + (r.amount || 0), 0) || 0;

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count: newUsers24h } = await supabase
            .from('profiles')
            .select('*', { count: 'exact', head: true })
            .gte('created_at', oneDayAgo);

        return res.status(200).json({
            totalUsers: totalUsers || 0,
            totalPosts: totalPosts || 0,
            totalInteractions: (totalLikes || 0) + (totalComments || 0),
            totalRevenue: totalRevenue,
            newUsers24h: newUsers24h || 0
        });
    } catch (err) {
        console.error('Overview Stats Error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

export const getUserGrowth = async (req, res) => {
    try {
        const { days = 30 } = req.query;
        const daysInt = parseInt(days);

        // Try NeonDB daily growth table first
        const growthQuery = `
            SELECT metric_date::text as date, new_users as count
            FROM analytics_daily_growth
            WHERE metric_date >= CURRENT_DATE - INTERVAL '${daysInt} days'
            ORDER BY metric_date ASC
        `;

        const result = await query(growthQuery);

        if (result && result.rows && result.rows.length > 0) {
            return res.status(200).json(result.rows);
        }

        // Fallback to Supabase
        console.log('📊 Neon daily growth empty, falling back to Supabase...');
        const daysAgo = new Date(Date.now() - daysInt * 24 * 60 * 60 * 1000).toISOString();

        const { data, error } = await supabase
            .from('profiles')
            .select('created_at')
            .gte('created_at', daysAgo)
            .order('created_at', { ascending: true });

        if (error) throw error;

        // Group by date
        const growthMap = {};
        const startDate = new Date(daysAgo);
        const today = new Date();

        for (let d = new Date(startDate); d <= today; d.setDate(d.getDate() + 1)) {
            const dateKey = d.toISOString().split('T')[0];
            growthMap[dateKey] = 0;
        }

        data?.forEach(profile => {
            const dateKey = profile.created_at.split('T')[0];
            if (growthMap[dateKey] !== undefined) {
                growthMap[dateKey]++;
            }
        });

        const formattedData = Object.entries(growthMap).map(([date, count]) => ({
            date,
            count
        }));

        return res.status(200).json(formattedData);
    } catch (err) {
        console.error('User Growth Error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

export const getPostActivity = async (req, res) => {
    try {
        const { days = 30 } = req.query;
        const daysInt = parseInt(days);

        // Try NeonDB daily growth table first
        const activityQuery = `
            SELECT metric_date::text as date, new_posts as count
            FROM analytics_daily_growth
            WHERE metric_date >= CURRENT_DATE - INTERVAL '${daysInt} days'
            ORDER BY metric_date ASC
        `;

        const result = await query(activityQuery);

        if (result && result.rows && result.rows.length > 0) {
            return res.status(200).json(result.rows);
        }

        // Fallback to Supabase
        console.log('📊 Neon post activity empty, falling back to Supabase...');
        const daysAgo = new Date(Date.now() - daysInt * 24 * 60 * 60 * 1000).toISOString();

        const { data, error } = await supabase
            .from('posts')
            .select('created_at')
            .gte('created_at', daysAgo)
            .order('created_at', { ascending: true });

        if (error) throw error;

        const activityMap = {};
        const startDate = new Date(daysAgo);
        const today = new Date();

        for (let d = new Date(startDate); d <= today; d.setDate(d.getDate() + 1)) {
            const dateKey = d.toISOString().split('T')[0];
            activityMap[dateKey] = 0;
        }

        data?.forEach(post => {
            const dateKey = post.created_at.split('T')[0];
            if (activityMap[dateKey] !== undefined) {
                activityMap[dateKey]++;
            }
        });

        const formattedData = Object.entries(activityMap).map(([date, count]) => ({
            date,
            count
        }));

        return res.status(200).json(formattedData);
    } catch (err) {
        console.error('Post Activity Error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

export const getEngagementMetrics = async (req, res) => {
    try {
        const { limit = 10 } = req.query;

        // Try NeonDB top posts cache first
        const topPostsQuery = `
            SELECT 
                post_id as id,
                title,
                created_at,
                likes_count,
                comments_count,
                total_engagement
            FROM analytics_top_posts
            ORDER BY total_engagement DESC
            LIMIT $1
        `;

        const result = await query(topPostsQuery, [parseInt(limit)]);

        if (result && result.rows && result.rows.length > 0) {
            return res.status(200).json(result.rows);
        }

        // Fallback to Supabase
        console.log('📊 Neon top posts empty, falling back to Supabase...');
        const { data: posts, error } = await supabase
            .from('posts')
            .select('id, title, created_at')
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) throw error;

        const postsWithEngagement = await Promise.all(
            posts.map(async (post) => {
                const { count: likesCount } = await supabase
                    .from('likes')
                    .select('*', { count: 'exact', head: true })
                    .eq('post_id', post.id);

                const { count: commentsCount } = await supabase
                    .from('comments')
                    .select('*', { count: 'exact', head: true })
                    .eq('post_id', post.id);

                return {
                    ...post,
                    likes_count: likesCount || 0,
                    comments_count: commentsCount || 0,
                    total_engagement: (likesCount || 0) + (commentsCount || 0)
                };
            })
        );

        const topPosts = postsWithEngagement
            .sort((a, b) => b.total_engagement - a.total_engagement)
            .slice(0, parseInt(limit));

        return res.status(200).json(topPosts);
    } catch (err) {
        console.error('Engagement Metrics Error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

export const getLiveTickerData = async (req, res) => {
    try {
        // Check Neon first
        const tickerQuery = `
            SELECT username, display_name, created_at, avatar_url
            FROM analytics_profiles
            ORDER BY created_at DESC
            LIMIT 10
        `;

        const result = await query(tickerQuery);

        if (result && result.rows && result.rows.length > 0) {
            return res.status(200).json(result.rows);
        }

        // Fallback to Supabase
        const { data, error } = await supabase
            .from('profiles')
            .select('username, display_name, created_at, avatar_url')
            .order('created_at', { ascending: false })
            .limit(10);

        if (error) {
            console.error('Supabase Query Error:', error);
            return res.status(500).json({ error: 'Failed to fetch ticker data' });
        }

        return res.status(200).json(data || []);
    } catch (err) {
        console.error('Ticker Data Error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

// ============================================================================
// Sync Functions - Periodically sync Supabase data to Neon
// ============================================================================

export const syncAnalyticsData = async (req, res) => {
    try {
        console.log('🔄 Starting analytics data sync from Supabase to Neon...');

        // Check if Neon tables exist first
        const tableCheckQuery = `
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'analytics_profiles'
            ) as table_exists
        `;

        const tableCheck = await query(tableCheckQuery);

        if (!tableCheck || !tableCheck.rows[0]?.table_exists) {
            console.error('❌ Analytics tables not found in Neon. Please deploy the schema first.');
            return res.status(400).json({
                error: 'Schema not deployed',
                message: 'Please deploy vtx-backend/migrations/001_analytics_schema.sql to Neon first',
                instructions: 'Run the SQL file in Neon Console at https://console.neon.tech/'
            });
        }

        // Sync Profiles (limited batch for performance)
        const { data: profiles, error: profilesError } = await supabase
            .from('profiles')
            .select('id, username, display_name, email, avatar_url, created_at, email_confirmed_at')
            .limit(1000); // Batch limit to avoid timeout

        if (profilesError) {
            throw new Error(`Supabase profiles query failed: ${profilesError.message}`);
        }

        if (profiles && profiles.length > 0) {
            console.log(`📥 Fetched ${profiles.length} profiles from Supabase`);

            // Batch insert
            for (let i = 0; i < profiles.length; i += 100) {
                const batch = profiles.slice(i, i + 100);
                const values = batch.map(p =>
                    `('${p.id}', ${p.username ? `'${p.username}'` : 'NULL'}, ${p.display_name ? `'${p.display_name.replace(/'/g, "''")}'` : 'NULL'}, ${p.email ? `'${p.email}'` : 'NULL'}, ${p.avatar_url ? `'${p.avatar_url}'` : 'NULL'}, '${p.created_at}', ${p.email_confirmed_at ? `'${p.email_confirmed_at}'` : 'NULL'})`
                ).join(',');

                await query(`
                    INSERT INTO analytics_profiles (id, username, display_name, email, avatar_url, created_at, email_confirmed_at)
                    VALUES ${values}
                    ON CONFLICT (id) DO UPDATE SET last_synced_at = NOW()
                `);
            }
            console.log(`✅ Synced ${profiles.length} profiles to Neon`);
        }

        // Refresh aggregated caches
        console.log('🔄 Refreshing analytics caches...');
        await query('SELECT refresh_analytics_stats_cache()');
        await query('SELECT refresh_daily_growth_metrics(90)');
        await query('SELECT refresh_top_posts(100)');
        console.log('✅ Caches refreshed!');

        console.log('✅ Analytics sync complete!');
        return res.status(200).json({
            success: true,
            synced: {
                profiles: profiles?.length || 0
            },
            message: 'Analytics data synced successfully',
            next_steps: 'Analytics dashboard should now load from Neon cache'
        });
    } catch (err) {
        console.error('❌ Sync Error:', err);
        return res.status(500).json({
            error: 'Sync failed',
            details: err.message,
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
};


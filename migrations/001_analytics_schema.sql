-- ═══════════════════════════════════════════════════════════════════════════
-- NeonDB Analytics Schema - Complete Migration from Supabase
-- ═══════════════════════════════════════════════════════════════════════════
-- 
-- This schema creates tables in NeonDB to mirror analytics data from Supabase
-- Benefits: Faster queries, lower costs, independent analytics layer
--
-- ═══════════════════════════════════════════════════════════════════════════

-- Table 1: Profiles Mirror (for analytics only)
CREATE TABLE IF NOT EXISTS analytics_profiles (
    id UUID PRIMARY KEY,
    username TEXT,
    display_name TEXT,
    email TEXT,
    avatar_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE,
    email_confirmed_at TIMESTAMP WITH TIME ZONE,
    last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_profiles_created_at ON analytics_profiles(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_profiles_username ON analytics_profiles(username);

-- Table 2: Posts Mirror (for analytics only)
CREATE TABLE IF NOT EXISTS analytics_posts (
    id UUID PRIMARY KEY,
    user_id UUID,
    title TEXT,
    type TEXT,
    created_at TIMESTAMP WITH TIME ZONE,
    last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_posts_created_at ON analytics_posts(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_posts_user_id ON analytics_posts(user_id);

-- Table 3: Likes Mirror
CREATE TABLE IF NOT EXISTS analytics_likes (
    id UUID PRIMARY KEY,
    user_id UUID,
    post_id UUID,
    created_at TIMESTAMP WITH TIME ZONE,
    last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_likes_post_id ON analytics_likes(post_id);
CREATE INDEX IF NOT EXISTS idx_analytics_likes_created_at ON analytics_likes(created_at);

-- Table 4: Comments Mirror
CREATE TABLE IF NOT EXISTS analytics_comments (
    id UUID PRIMARY KEY,
    user_id UUID,
    post_id UUID,
    created_at TIMESTAMP WITH TIME ZONE,
    last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_comments_post_id ON analytics_comments(post_id);
CREATE INDEX IF NOT EXISTS idx_analytics_comments_created_at ON analytics_comments(created_at);

-- Table 5: Revenue Data (Ad Credits)
CREATE TABLE IF NOT EXISTS analytics_revenue (
    id UUID PRIMARY KEY,
    user_id UUID,
    amount NUMERIC,
    status TEXT,
    created_at TIMESTAMP WITH TIME ZONE,
    last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_revenue_status ON analytics_revenue(status);
CREATE INDEX IF NOT EXISTS idx_analytics_revenue_created_at ON analytics_revenue(created_at);

-- Table 6: Aggregated Stats Cache (for fast overview queries)
CREATE TABLE IF NOT EXISTS analytics_stats_cache (
    metric_name TEXT PRIMARY KEY,
    metric_value BIGINT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Pre-populate with metric names
INSERT INTO analytics_stats_cache (metric_name, metric_value) VALUES
    ('total_users', 0),
    ('total_posts', 0),
    ('total_likes', 0),
    ('total_comments', 0),
    ('total_revenue', 0),
    ('new_users_24h', 0)
ON CONFLICT (metric_name) DO NOTHING;

-- Table 7: Daily Growth Metrics (Materialized for performance)
CREATE TABLE IF NOT EXISTS analytics_daily_growth (
    metric_date DATE PRIMARY KEY,
    new_users BIGINT DEFAULT 0,
    new_posts BIGINT DEFAULT 0,
    new_likes BIGINT DEFAULT 0,
    new_comments BIGINT DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_daily_growth_date ON analytics_daily_growth(metric_date DESC);

-- Table 8: Top Content Cache (Updated periodically)
CREATE TABLE IF NOT EXISTS analytics_top_posts (
    post_id UUID PRIMARY KEY,
    title TEXT,
    created_at TIMESTAMP WITH TIME ZONE,
    likes_count BIGINT DEFAULT 0,
    comments_count BIGINT DEFAULT 0,
    total_engagement BIGINT DEFAULT 0,
    rank INTEGER,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_top_posts_engagement ON analytics_top_posts(total_engagement DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- Helper Functions
-- ═══════════════════════════════════════════════════════════════════════════

-- Function: Refresh Stats Cache
CREATE OR REPLACE FUNCTION refresh_analytics_stats_cache() RETURNS VOID AS $$
BEGIN
    -- Update total counts
    UPDATE analytics_stats_cache SET metric_value = (SELECT COUNT(*) FROM analytics_profiles), updated_at = NOW() WHERE metric_name = 'total_users';
    UPDATE analytics_stats_cache SET metric_value = (SELECT COUNT(*) FROM analytics_posts), updated_at = NOW() WHERE metric_name = 'total_posts';
    UPDATE analytics_stats_cache SET metric_value = (SELECT COUNT(*) FROM analytics_likes), updated_at = NOW() WHERE metric_name = 'total_likes';
    UPDATE analytics_stats_cache SET metric_value = (SELECT COUNT(*) FROM analytics_comments), updated_at = NOW() WHERE metric_name = 'total_comments';
    UPDATE analytics_stats_cache SET metric_value = (SELECT COALESCE(SUM(amount), 0) FROM analytics_revenue WHERE status = 'approved'), updated_at = NOW() WHERE metric_name = 'total_revenue';
    UPDATE analytics_stats_cache SET metric_value = (SELECT COUNT(*) FROM analytics_profiles WHERE created_at >= NOW() - INTERVAL '24 hours'), updated_at = NOW() WHERE metric_name = 'new_users_24h';
END;
$$ LANGUAGE plpgsql;

-- Function: Refresh Daily Growth Metrics
CREATE OR REPLACE FUNCTION refresh_daily_growth_metrics(lookback_days INT DEFAULT 90) RETURNS VOID AS $$
BEGIN
    -- Insert/Update daily growth data
    INSERT INTO analytics_daily_growth (metric_date, new_users, new_posts, updated_at)
    SELECT 
        DATE(created_at) as metric_date,
        COUNT(*) as new_users,
        0 as new_posts,
        NOW() as updated_at
    FROM analytics_profiles
    WHERE created_at >= CURRENT_DATE - (lookback_days || ' days')::INTERVAL
    GROUP BY DATE(created_at)
    ON CONFLICT (metric_date) 
    DO UPDATE SET new_users = EXCLUDED.new_users, updated_at = NOW();

    -- Update posts count
    UPDATE analytics_daily_growth dg
    SET new_posts = subq.cnt, updated_at = NOW()
    FROM (
        SELECT DATE(created_at) as metric_date, COUNT(*) as cnt
        FROM analytics_posts
        WHERE created_at >= CURRENT_DATE - (lookback_days || ' days')::INTERVAL
        GROUP BY DATE(created_at)
    ) subq
    WHERE dg.metric_date = subq.metric_date;
END;
$$ LANGUAGE plpgsql;

-- Function: Refresh Top Posts
CREATE OR REPLACE FUNCTION refresh_top_posts(limit_count INT DEFAULT 100) RETURNS VOID AS $$
BEGIN
    TRUNCATE analytics_top_posts;
    
    INSERT INTO analytics_top_posts (post_id, title, created_at, likes_count, comments_count, total_engagement, rank, updated_at)
    SELECT 
        p.id,
        p.title,
        p.created_at,
        COALESCE(l.likes_count, 0) as likes_count,
        COALESCE(c.comments_count, 0) as comments_count,
        COALESCE(l.likes_count, 0) + COALESCE(c.comments_count, 0) as total_engagement,
        ROW_NUMBER() OVER (ORDER BY COALESCE(l.likes_count, 0) + COALESCE(c.comments_count, 0) DESC) as rank,
        NOW()
    FROM analytics_posts p
    LEFT JOIN (
        SELECT post_id, COUNT(*) as likes_count
        FROM analytics_likes
        GROUP BY post_id
    ) l ON p.id = l.post_id
    LEFT JOIN (
        SELECT post_id, COUNT(*) as comments_count
        FROM analytics_comments
        GROUP BY post_id
    ) c ON p.id = c.post_id
    ORDER BY total_engagement DESC
    LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════
-- Manual Refresh Commands (Run these periodically or via cron)
-- ═══════════════════════════════════════════════════════════════════════════

-- SELECT refresh_analytics_stats_cache();
-- SELECT refresh_daily_growth_metrics(90);
-- SELECT refresh_top_posts(100);

-- ═══════════════════════════════════════════════════════════════════════════
-- Schema Ready! Next: Implement sync job in vtx-backend
-- ═══════════════════════════════════════════════════════════════════════════

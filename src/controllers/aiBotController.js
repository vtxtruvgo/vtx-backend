import { createClient } from '@supabase/supabase-js'
// import { GoogleGenerativeAI } from '@google/generative-ai' // Removed for Universal Mode

// Environment variables are loaded automatically in Vercel.
// Make sure to add VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY to Vercel Project Settings.

// Firebase Imports
import { initializeApp } from 'firebase/app'
import { getFirestore, collection, addDoc } from 'firebase/firestore'

// Global Firebase Instance (Cached for Vercel warm starts)
let db = null

// --- EMBEDDED POLL CREATOR LOGIC ---
const AiPollCreator = {
    process(aiResult) {
        // deep copy to avoid mutation issues
        const result = JSON.parse(JSON.stringify(aiResult))

        if (result.action !== 'CREATE_POST' || !result.post_data) {
            return result
        }

        // 1. Check if we have valid widget data already
        const hasValidWidget = result.poll_data?.options?.length >= 2

        // 2. Scan content for "Text Poll" patterns
        // Check for Aggressive Mode (Title says "Poll")
        // Check for Aggressive Mode (Title says "Poll")
        const title = (result.post_data.title || "").toLowerCase()
        // STRICTER CHECK: Only aggressive if keywords present AND explicit intent detected
        const isAggressiveContext = (title.includes("poll") || title.includes("vote")) && result.poll_data;

        const content = result.post_data.content || ""
        const scrubbed = this.scrubContent(content, isAggressiveContext)

        // 3. Decision Logic
        if (hasValidWidget) {
            // We have a widget.
            // If we ALSO detected a text list in the content that looks like the poll options, remove it to avoid duplication.
            if (scrubbed.foundOptions.length > 0) {
                console.log("🧹 Cleaning up redundant text options since widget exists.")
                result.post_data.content = scrubbed.cleanContent
            }
            return result
        }

        // 4. No widget? Try to create one from scrubbed data
        if (scrubbed.foundOptions.length >= 2) {
            console.log("✨ Converting detected text list to Poll Widget:", scrubbed.foundOptions)

            result.poll_data = {
                question: result.post_data.title, // Default to title
                options: scrubbed.foundOptions.slice(0, 5) // Max 5
            }

            // Should we force the content to be the clean version? Yes.
            // But if the clean content is empty, adding a fallback.
            result.post_data.content = scrubbed.cleanContent || "Cast your vote below! 👇"
        }

        return result
    },

    scrubContent(text, isAggressive) {
        const lines = text.split('\n')
        const options = []
        const cleanLines = []

        let isCapturing = false
        // Regex to catch standard poll headers
        const pollHeaderRegex = /^(poll options|options|choices|candidates|vote for|vote|question)/i
        const questionRegex = /[?:]\s*$/  // Ends in ? or :

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim()
            if (!line) {
                if (!isCapturing) cleanLines.push(lines[i]) // Preserve whitespace unless capturing
                continue
            }

            // CLEAN MARKDOWN (Simple strip for analysis)
            // Remove *, #, _, [, ]
            const cleanLine = line.replace(/[*_#\[\]]/g, '').trim()

            // 1. Check for Explicit Header
            if (cleanLine.match(pollHeaderRegex)) {
                isCapturing = true
                continue
            }

            // 2. Check for "Implicit Question Header" (Question followed by short lines)
            // Or if we are in AGGRESSIVE mode, any question (or text block) might start a list
            // Use Clean Line for detection
            if ((cleanLine.match(questionRegex) || isAggressive) && !isCapturing) {
                // Look ahead to next non-empty line
                let nextIdx = i + 1
                while (nextIdx < lines.length && !lines[nextIdx].trim()) nextIdx++

                if (nextIdx < lines.length) {
                    const nextLine = lines[nextIdx].trim()
                    const cleanNextLine = nextLine.replace(/[*_#\[\]]/g, '').trim()

                    // CRITICAL FIX: In Aggressive Mode, valid list item = ANY short line (no bullet needed)
                    // Regular Mode: Must start with bullet/number
                    // Use cleanNextLine for match to ignore markdown
                    const nextIsBullet = cleanNextLine.match(/^([-*]|\d+[.)])/)
                    const nextIsShortText = cleanNextLine.length < 50 && !cleanNextLine.match(/[.!?]$/)

                    const nextIsList = nextIsBullet || (isAggressive && nextIsShortText)

                    if (nextIsList) {
                        isCapturing = true
                        cleanLines.push(lines[i])
                        continue
                    }
                }
            }

            // 3. Check for Checkboxes or Bullets (Classic & Markdown)
            // MATCH ON CLEAN LINE to handle "**1. Option**"
            const listMatch = cleanLine.match(/^([-*]\s*(\[.?\])?|\d+[.)])\s*(.+)/)

            if (listMatch) {
                const opt = listMatch[3].trim()
                if (opt.length < 100) {
                    options.push(opt)
                    isCapturing = true
                    continue
                }
            }

            // 4. Implicit List Item in Aggressive Mode (No bullets)
            const endsWithPunctuation = /[.!?]$/.test(cleanLine)
            if (isCapturing && cleanLine.length < 80 && !endsWithPunctuation) {
                // If we are capturing, we take the cleaned option
                options.push(cleanLine)
                continue
            }

            // 5. Exit Capture
            if (isCapturing && (line.length > 80 || endsWithPunctuation)) {
                // If we hit a standard paragraph, stop capturing
                isCapturing = false
            }

            if (!isCapturing) {
                cleanLines.push(lines[i])
            }
        }

        return {
            originalLineCount: lines.length,
            cleanContent: cleanLines.join('\n').trim(),
            foundOptions: options
        }
    }
}
// -----------------------------------

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed')

    const { type, table, record } = req.body

    // Listen to INSERT events on all interaction tables
    const validTables = ['comments', 'posts', 'threads', 'thread_comments']
    if (type !== 'INSERT' || !validTables.includes(table)) {
        return res.status(200).json({ message: 'Ignored event/table' })
    }

    const item = record
    // Normalize content field (Handle various post types: Text, Code, Meme)
    const content = item.content || item.body || item.description || item.caption || item.code_snippet || item.title || ''

    // Ignore empty, self-loops, or specific keywords
    if (!content || content.startsWith('🤖') || content.includes('[AI Reply]')) {
        return res.status(200).json({ message: 'Ignored own content' })
    }

    try {
        const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
        const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY

        const ENV_AI_KEY = process.env.AI_API_KEY || process.env.VITE_AI_API_KEY || process.env.GEMINI_API_KEY

        if (!SUPABASE_URL || !SUPABASE_KEY) {
            console.error('Missing Environment Keys in Vercel (Supabase)')
            return res.status(500).json({ error: 'Server Configuration Error' })
        }

        const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

        // Fetch All Configs (User ID, System Prompt, Temperature, Firebase)
        const { data: configRows } = await supabase
            .from('ai_config')
            .select('key, value')
            .in('key', [
                'bot_user_id', 'system_instruction', 'bot_temperature', 'ai_model',
                'firebase_api_key', 'firebase_project_id',
                'ai_provider', 'ai_base_url', 'ai_api_key'
            ])

        const configMap = {}
        configRows?.forEach(row => configMap[row.key] = row.value)

        const botUserId = configMap.bot_user_id
        const provider = configMap.ai_provider || 'google'

        // CRITICAL: Prevent Infinite Loops
        // Check if the author of the record is the bot itself
        const authorId = record.user_id || record.author_id
        if (authorId && botUserId && authorId === botUserId) {
            console.log('🛑 Ignored self-trigger (Author is Bot)')
            return res.status(200).json({ message: 'Ignored self-trigger' })
        }

        // Map provider to trigger keyword
        const providerTriggers = {
            'google': '@gemini',
            'ollama': '@ollama',
            'openai': '@gpt'
        }
        const providerTrigger = providerTriggers[provider] || '@bot'

        // Check Trigger (Dynamic based on provider)
        const lowerContent = content.toLowerCase()
        const isTriggered = lowerContent.includes(providerTrigger.toLowerCase()) ||
            lowerContent.includes('hey ai')
        // Removed generic 'bot' trigger to prevent accidental loops

        if (!isTriggered) {
            return res.status(200).json({ message: 'No trigger keyword found' })
        }

        // STRICT DEDUPLICATION: "Claim Check" Pattern
        // 1. Try to claim this trigger immediately by inserting a processing record
        let claimId = null;
        try {
            const { data: claim, error: claimError } = await supabase.from('ai_memories_log').insert({
                trigger_id: item.id,
                input_text: content,
                output_text: '(PROCESSING)',
                trigger_source: `webhook:${table}`
            }).select('id').single()

            if (claimError) {
                // If unique constraint allows, this might fail on duplicate
                // If it doesn't, we might insert a duplicate. 
                // We double check below.
                if (claimError.code === '23505') { // Unique Violation
                    console.log('🛑 Duplicate trigger ignored (Unique Constraint):', item.id)
                    return res.status(200).json({ message: 'Duplicate trigger (already processed)' })
                }
                // If other error, we might log but proceed carefully or throw
                console.warn('Claim insert warning:', claimError)
            } else {
                claimId = claim.id
            }

        } catch (err) {
            console.log('Claim error', err)
        }

        // 2. Race Condition Guard (for environments without Unique Constraint)
        // Check if ANY record exists for this trigger that isn't our just-created one (or if ours wasn't created)
        const { data: claims } = await supabase
            .from('ai_memories_log')
            .select('id, created_at')
            .eq('trigger_id', item.id)
            .order('created_at', { ascending: true })
            .limit(2)

        if (claims && claims.length > 0) {
            const firstClaim = claims[0]
            // If we have a claimId, make sure WE are the first one
            if (claimId && firstClaim.id !== claimId) {
                console.log('🛑 Race condition detected. Yielding to first claim.', item.id)
                // Optionally delete our losing claim to keep log clean
                await supabase.from('ai_memories_log').delete().eq('id', claimId)
                return res.status(200).json({ message: 'Duplicate trigger (race detected)' })
            }
            // If we didn't initiate a claim (error above) but one exists, stop
            if (!claimId) {
                console.log('🛑 Duplicate trigger found:', item.id)
                return res.status(200).json({ message: 'Duplicate trigger (found existing)' })
            }
        }

        console.log(`⚡ Processing Trigger ${item.id} (Claimed)`)

        // Default URLs (handle null, empty, or undefined)
        let baseUrl = configMap.ai_base_url
        if (!baseUrl || baseUrl === 'null' || baseUrl.trim() === '') {
            if (provider === 'ollama') baseUrl = 'http://localhost:11434/v1'
            else if (provider === 'openai') baseUrl = 'https://api.openai.com/v1'
            else if (provider === 'google') baseUrl = 'https://generativelanguage.googleapis.com/v1beta'
        }

        const apiKey = configMap.ai_api_key || ENV_AI_KEY
        const systemInstruction = configMap.system_instruction || "You are a helpful assistant."
        const temperature = parseFloat(configMap.bot_temperature || '0.7')
        const modelName = configMap.ai_model || "gemini-2.0-flash"

        // Personality & Moderation Settings (OPTIONAL - safe defaults)
        const personalityPreset = (configMap.bot_personality_preset || 'friendly')
        const botTone = parseInt(configMap.bot_tone || '30')
        const emojiLevel = (configMap.bot_emoji_level || 'moderate')
        const expertiseLevel = (configMap.bot_expertise_level || 'intermediate')
        const verbosity = (configMap.bot_verbosity || 'balanced')
        const autoPostCreation = (configMap.auto_post_creation !== 'false') // Default TRUE

        if (!botUserId) {
            console.error('Bot User ID not configured')
            if (claimId) await supabase.from('ai_memories_log').update({ output_text: 'ERROR: Bot Not Configured' }).eq('id', claimId)
            return res.status(500).json({ error: 'Bot not configured' })
        }

        // --- UNIVERSAL GENERATE FUNCTION ---
        async function generateText(promptText) {
            console.log(`📡 generating text with provider: ${provider}, model: ${modelName}`)

            if (provider === 'google') {
                // Use REST API instead of SDK
                if (!apiKey) throw new Error("Missing Google API Key (Check Admin Console or .env)")

                const url = `${baseUrl.replace(/\/$/, '')}/${modelName}:generateContent?key=${apiKey}`
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: promptText }] }],
                        generationConfig: { temperature: temperature }
                    })
                })

                if (!response.ok) {
                    const errorText = await response.text()
                    console.error('Google API Error:', errorText)
                    throw new Error(`Google API Error: ${response.status}`)
                }

                const data = await response.json()
                return data.candidates?.[0]?.content?.parts?.[0]?.text || "Error: No response"
            }
            else {
                // UNIVERSAL / OLLAMA FETCH
                const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`

                const messages = [
                    { role: "system", content: systemInstruction },
                    { role: "user", content: promptText }
                ]

                console.log(`📡 Calling API: ${endpoint}`)

                // For local Ollama, API Key might not be needed, but we send if present
                const headers = {
                    'Content-Type': 'application/json'
                }
                if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({
                        model: modelName,
                        messages: messages,
                        temperature: temperature,
                        stream: false
                    })
                })

                if (!response.ok) {
                    const errText = await response.text()
                    try {
                        const errJson = JSON.parse(errText)
                        console.error('API Error JSON:', errJson)
                    } catch (e) {
                        console.error('API Error Text:', errText)
                    }
                    throw new Error(`Provider API Error ${response.status}`)
                }

                const data = await response.json()
                return data.choices?.[0]?.message?.content || data.response || "Error: No response content"
            }
        }

        // --- INITIALIZE FIREBASE (If needed) ---
        if (!db && configMap.firebase_api_key && configMap.firebase_project_id) {
            try {
                const firebaseConfig = {
                    apiKey: configMap.firebase_api_key,
                    projectId: configMap.firebase_project_id
                }
                const app = initializeApp(firebaseConfig)
                db = getFirestore(app)
                console.log('✅ Firebase initialized for Memory Logging')
            } catch (fbError) {
                console.error('⚠️ Firebase Init Error:', fbError.message)
            }
        }

        // Fetch User Profile for Context & Logging
        const { data: userProfile } = await supabase
            .from('profiles')
            .select('username, display_name, role, is_verified')
            .eq('id', item.user_id)
            .single()

        const username = userProfile?.username || 'User'

        // --- FETCH DEEP CONTEXT (Activity & History) ---

        // 1. User Activity (Memory)
        let userActivityContext = "User Activity: New user or minimal history."
        if (item.user_id) {
            const { data: recentPosts } = await supabase.from('posts').select('title, tags').eq('user_id', item.user_id).order('created_at', { ascending: false }).limit(3)
            const { data: recentComments } = await supabase.from('comments').select('content').eq('user_id', item.user_id).order('created_at', { ascending: false }).limit(3)

            const postsSummary = recentPosts?.length ? recentPosts.map(p => `"${p.title}"`).join(', ') : 'None'
            userActivityContext = `User Activity Summary:\n- Recent Posts: ${postsSummary}\n- Recent Comments: ${recentComments?.length || 0} recent interactions.`
        }

        // 3. Thread/Post Context (Immediate Context)
        let contextData = ""
        let pollContext = ""
        let pollOptionsForPrompt = []

        if (table === 'comments' && item.post_id) {
            const { data: post } = await supabase.from('posts').select('title, description, code_snippet, type').eq('id', item.post_id).single()
            if (post) {
                contextData = `Parent Post: "${post.title}"\n${post.description?.substring(0, 300)}...`

                // Fetch Poll if exists
                const { data: poll } = await supabase.from('polls').select('*').eq('post_id', item.post_id).single()
                if (poll) {
                    const { data: options } = await supabase.from('poll_options').select('*').eq('poll_id', poll.id)
                    pollContext = `\nATTACHED POLL: "${poll.question}"\nOptions:\n${options.map(o => `- [ID: ${o.id}] ${o.option_text}`).join('\n')}`
                    pollOptionsForPrompt = options
                }
            }
        }
        else if (item.thread_id) {
            const { data: thread } = await supabase.from('threads').select('title').eq('id', item.thread_id).single()
            if (thread) contextData = `Parent Thread: "${thread.title}"`
        }

        // 3. Assemble Full Prompt
        const fullPrompt = `
        IMMEDIATE CONTEXT:
        ${contextData || "(No direct thread context)"}
        ${pollContext}
        
        USER HISTORY & ACTIVITY:
        ${userActivityContext}
        
        CURRENT USER MESSAGE:
        ${content}
        `

        // --- BUILD PERSONALITY-DRIVEN SYSTEM PROMPT ---
        function buildPersonalityPrompt() {
            let prompt = systemInstruction + '\n\n'

            // Personality Preset
            const presetInstructions = {
                professional: 'You are PROFESSIONAL and FORMAL. Use structured language, complete sentences, and technical terminology. Be thorough and detailed.',
                friendly: 'You are FRIENDLY and WARM. Use casual language, be approachable and helpful. Make users feel comfortable asking questions.',
                enthusiastic: 'You are SUPER ENTHUSIASTIC and ENERGETIC! Be motivating, exciting, and inspiring! Use lots of exclamation marks!',
                teacher: 'You are a PATIENT TEACHER. Explain concepts step-by-step with examples. Break down complex topics into simple terms.',
                sarcastic: 'You are WITTY and SARCASTIC. Use humor, playful teasing, and clever remarks. Keep it light and fun.',
                custom: '' // Use only system_instruction
            }
            if (personalityPreset !== 'custom') {
                prompt += presetInstructions[personalityPreset] || '' + '\n'
            }

            // Tone
            if (botTone < 30) {
                prompt += 'Tone: Very casual and fun. Use slang, contractions, and informal language.\n'
            } else if (botTone < 60) {
                prompt += 'Tone: Balanced - professional but approachable.\n'
            } else {
                prompt += 'Tone: Very formal and professional. Use proper grammar and formal structure.\n'
            }

            // Emoji Level
            const emojiInstructions = {
                none: 'DO NOT use any emoji.',
                minimal: 'Use 1-2 emoji per response for emphasis.',
                moderate: 'Use 3-5 emoji to make responses engaging and fun.',
                high: 'Use LOTS of emoji! 🎉 Every sentence should have at least one! ✨'
            }
            prompt += emojiInstructions[emojiLevel] || '' + '\n'

            // Expertise Level
            const expertiseInstructions = {
                beginner: 'Target audience: BEGINNERS. Use simple explanations, avoid jargon, provide lots of context and examples.',
                intermediate: 'Target audience: INTERMEDIATE developers. Balance detail with clarity.',
                expert: 'Target audience: EXPERT developers. Be concise and technical. Assume advanced knowledge.'
            }
            prompt += expertiseInstructions[expertiseLevel] || '' + '\n'

            // Verbosity
            const verbosityInstructions = {
                concise: 'Be VERY CONCISE. Short, direct answers only. No fluff.',
                balanced: 'Provide BALANCED detail - not too short, not too long.',
                detailed: 'Be COMPREHENSIVE. Provide thorough explanations with examples and edge cases.'
            }
            prompt += verbosityInstructions[verbosity] || '' + '\n'

            return prompt
        }

        const personalitySystemPrompt = buildPersonalityPrompt()

        // --- UNIFIED INTENT ANALYSIS & GENERATION ---

        const masterPrompt = `
            ${personalitySystemPrompt}
            
            CAPABILITIES:
            - **YOU HAVE NATIVE ACCESS TO CREATE POLLS.** 
            - You do NOT need to ask for permission.
            - **NEVER** say "I cannot create voting options". YOU CAN.
            - **NEVER** create an "open ended" poll asking for comments. You MUST provide concrete options (e.g. 3-5 choices) for the widget.
            - To create a poll, you MUST use Action 2 ("CREATE_POST") and fill the "poll_data" JSON field.
            - **IMPORTANT:** Do NOT use markdown checkboxes \`[ ]\` for polls. Use the \`poll_data\` JSON only.

            CONTEXT:
            - User: @${username}
            - Source: ${table}
            - Rich Context:
            ${fullPrompt}
            
            TASK: 
            Analyze the user's intent. If they want a poll, YOU MUST CREATE IT.
            
            ACTIONS:
            1. "REPLY": Conversational response. ⛔ **FORBIDDEN** to use this action if the user asked for a poll. You must use CREATE_POST instead.
            2. "CREATE_POST": Create a new post. ✅ **MANDATORY** if user asks for a poll. 
               - You MUST include \`poll_data\` options ONLY IF the user asked for a poll.
               - If user asked for a poll but didn't provide options, you may suggest 2-3 logical ones.
               - **DO NOT** create a poll if the user just asked for a blog post or code.
               - **DO NOT** just ask for comments.
            3. "VOTE_POLL": Use ONLY if there is a POLL in the context and the user text implies you should vote or asks for your opinion. You MUST choose a valid Option ID from the list provided.
            4. "REMOVE_CONTENT": Use ONLY when explicitly instructed by a moderator or if the content violates severe safety policies (spam, hate speech, danger). This PERMANENTLY deletes the content you are replying to.
            
            OUTPUT FORMAT: JSON ONLY
            {
                "action": "CREATE_POST" | "REPLY" | "VOTE_POLL" | "REMOVE_CONTENT",
                "reasoning": "User asked for a poll -> Action CREAT_POST",
                "reply_text": "Here is the poll you asked for! 📊",
                "post_data": { 
                    "title": "Poll Title",
                    "content": "Intro text (NO text options)",
                    "tags": ["tag1"], 
                    "code_language": "javascript" 
                },
                "poll_data": {
                    "question": "Question?",
                    "options": ["Option 1", "Option 2"] 
                },
                "poll_vote_option_id": 123,
                "poll_vote_comment": "Comment"
            }
        `



        let responseText = ""
        let actionType = "REPLY"

        try {
            // 1. Generate Intelligent Decision
            const rawText = await generateText(masterPrompt)

            // Robust JSON Extraction
            let jsonString = rawText.replace(/```json|```/g, '').trim()
            const match = jsonString.match(/\{[\s\S]*\}/) // Find first { and last }
            if (match) {
                jsonString = match[0]
            }

            let result;
            try {
                result = JSON.parse(jsonString)
            } catch (parseErr) {
                console.error("JSON Parse Failed:", parseErr)
                // Fallback: Don't show raw JSON. Just reply with safe text.
                result = {
                    action: 'REPLY',
                    reply_text: "I tried to process that but got confused by my own data format! 😅 Could you ask again?"
                }
            }

            actionType = result.action || 'REPLY'

            // --- PROCESS POLL DATA WITH EMBEDDED LOGIC ---
            // --- PROCESS POLL DATA WITH EMBEDDED LOGIC ---
            try {
                // FEATURE FLAGGING for Polls: 
                // Only process poll if the user EXPLICITLY asked for one or the content strongly implies it.

                const userIntent = content.toLowerCase();
                const wantsPoll = userIntent.includes('poll') || userIntent.includes('vote') || userIntent.includes('survey') || userIntent.includes('options');

                if (wantsPoll) {
                    result = AiPollCreator.process(result)
                } else {
                    // Force removal of poll data if not requested, to prevent "hallucinated" polls from being created
                    if (result.poll_data) {
                        console.log("🧹 Scrubbing unwanted poll data (User did not ask for poll).")
                        delete result.poll_data;
                    }
                }
            } catch (err) {
                console.warn('Poll Processing Error:', err)
            }
            // ---------------------------------------------

            if (actionType === 'CREATE_POST' && result.post_data) {
                // 2. Execute Creation
                const { data: newPost, error: postError } = await supabase.from('posts').insert({
                    user_id: botUserId,
                    title: result.post_data.title,
                    description: result.post_data.content, // Content should now be clean of poll options
                    code_snippet: null,
                    type: 'blog', // Default to blog for AI thoughts
                    tags: result.post_data.tags || []
                }).select().single()

                if (postError) {
                    console.error('Post creation error:', postError)
                    responseText = `❌ I encountered an error creating the post: ${postError.message} `
                } else {
                    responseText = result.reply_text || `✅ I've created the post: **"${result.post_data.title}"**`

                    // 2a. Handle Poll Creation (if poll_data exists)
                    if (result.poll_data && result.poll_data.options && result.poll_data.options.length >= 2) {
                        try {
                            // Enforce Max 5 Options
                            const cleanOptions = result.poll_data.options.slice(0, 5)

                            const { data: newPoll, error: pollError } = await supabase.from('polls').insert({
                                post_id: newPost.id,
                                question: result.poll_data.question || result.post_data.title,
                                allow_multiple_votes: false,
                                expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
                            }).select().single()

                            if (newPoll) {
                                const pollOptions = cleanOptions.map(opt => ({
                                    poll_id: newPoll.id,
                                    option_text: opt
                                }))
                                const { data: insertedOptions } = await supabase.from('poll_options').insert(pollOptions).select()

                                // OPTIONAL: AI Self-Vote (Kickstart the poll)
                                if (insertedOptions && insertedOptions.length > 0) {
                                    // Pick a random option or the first one to vote for
                                    const randomOption = insertedOptions[Math.floor(Math.random() * insertedOptions.length)]
                                    await supabase.from('poll_votes').insert({
                                        poll_id: newPoll.id,
                                        option_id: randomOption.id,
                                        user_id: botUserId
                                    })
                                    await supabase.rpc('increment_poll_vote', { option_id: randomOption.id })
                                }

                            } else if (pollError) {
                                console.error('Poll creation error:', pollError)
                            }
                        } catch (pollErr) {
                            console.error('Poll logic error:', pollErr)
                        }
                    }
                }

            } else if (actionType === 'VOTE_POLL' && result.poll_vote_option_id) {
                // 3. Execute Poll Vote
                const optionId = result.poll_vote_option_id

                // Validate Option ID
                const isValidOption = pollOptionsForPrompt.find(o => o.id === optionId)

                if (isValidOption) {
                    // Check if already voted (to avoid error)
                    const { data: existingVote } = await supabase.from('poll_votes')
                        .select('id').eq('user_id', botUserId).eq('option_id', optionId).maybeSingle()

                    if (!existingVote) {
                        const { error: voteError } = await supabase.from('poll_votes').insert({
                            poll_id: isValidOption.poll_id,
                            option_id: optionId,
                            user_id: botUserId
                        })

                        if (voteError) {
                            console.error('Vote error:', voteError)
                            responseText = `❌ I tried to vote but failed: ${voteError.message}`
                        } else {
                            // Update count manually just in case
                            await supabase.rpc('increment_poll_vote', { option_id: optionId })

                            responseText = result.reply_text || result.poll_vote_comment || `I voted for **"${isValidOption.option_text}"**! 🗳️`
                        }
                    } else {
                        responseText = "I've already voted on this poll! 😊"
                    }
                } else {
                    responseText = "I tried to vote, but that option ID seems invalid. 🤔"
                }

            } else if (actionType === 'REMOVE_CONTENT') {
                // 4. Execute Content Removal
                try {
                    // Check if table is valid for deletion
                    if (['posts', 'threads', 'comments'].includes(table)) {
                        const { error: delError } = await supabase.from(table).delete().eq('id', item.id)
                        if (delError) {
                            console.error('Deletion error:', delError)
                            responseText = `❌ Failed to remove content: ${delError.message}`
                        } else {
                            responseText = result.reply_text || "✅ Content removed successfully."
                            return res.status(200).json({ success: true, action: 'REMOVED', message: responseText })
                        }
                    } else {
                        responseText = "I cannot remove content from this source table."
                    }
                } catch (delErr) {
                    console.error('Delete Logic Error:', delErr)
                    responseText = "Error executing removal."
                }

            } else {
                // 5. Execute Reply
                responseText = result.reply_text || rawText
            }

        } catch (e) {
            console.error("AI Logic Error:", e)
            responseText = "I encountered a processing error. Please try again."
        }



        // --- SEND REPLY ---
        let targetTable = ''
        let payload = {
            user_id: botUserId,
            content: `🤖 ${responseText}`
        }

        if (table === 'posts') {
            targetTable = 'threads'
            payload.parent_post_id = item.id
        }
        else if (table === 'threads') {
            targetTable = 'thread_comments'
            payload.thread_id = item.id
        }
        else if (table === 'thread_comments') {
            targetTable = 'thread_comments'
            payload.thread_id = item.thread_id
        }
        else if (table === 'comments') {
            targetTable = 'comments'
            payload.post_id = item.post_id
        }

        await supabase.from(targetTable).insert(payload)

        // Log to Supabase (UPDATE CLAIM)
        if (claimId) {
            await supabase.from('ai_memories_log').update({
                output_text: responseText
            }).eq('id', claimId)
        } else {
            // Fallback: Insert if claim didn't exist for some reason
            await supabase.from('ai_memories_log').insert({
                input_text: content,
                output_text: responseText,
                trigger_source: `webhook:${table}`,
                trigger_id: item.id
            })
        }

        // Log to Neon DB (Heavy storage offload)
        // We use fire-and-forget for logging to not block response
        import('../db/neon.js').then(async ({ query }) => {
            try {
                await query(
                    `INSERT INTO ai_execution_logs (trigger_id, input_text, output_text, trigger_source, model, tokens) VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        item.id,
                        content,
                        responseText,
                        table,
                        configMap.ai_model || 'unknown',
                        Math.ceil(responseText.length / 4)
                    ]
                );
                console.log('✅ Logged to Neon DB');
            } catch (neonErr) {
                console.error('Neon Log Error:', neonErr.message);
            }
        });

    } catch (fbErr) {
        console.error('Log Error:', fbErr.message)
    }
}

return res.status(200).json({ success: true, reply: responseText })

    } catch (error) {
    console.error('Bot Error:', error)
    return res.status(500).json({ error: error.message })
}
}

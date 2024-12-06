const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

require('dotenv').config();
require('process');

const { BskyAgent, RichText, AppBskyRichtextFacet } = require('@atproto/api');
const { CronJob } = require('cron');

// SQLite Database Setup
const db = new sqlite3.Database('./news_data.db');

// OpenAI API Setup
const OPENAI_API_KEY = process.env.OPENAI_APIKEY;
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

// Initialize the SQLite database
function initializeDatabase() {
    db.run(`CREATE TABLE IF NOT EXISTS news_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        storyId INTEGER UNIQUE,
        title TEXT,
        url TEXT,
        commentSummary TEXT,
        retrieved INTEGER DEFAULT 0
    )`);
}

// Create a Bluesky Agent 
const agent = new BskyAgent({
    service: process.env.BLUESKY_SERVICE,
})

// Function to fetch top stories from Hacker News
async function fetchTopStories() {
    const url = 'https://hacker-news.firebaseio.com/v0/topstories.json';
    const response = await axios.get(url);
    return response.data.slice(0, 15); // Fetch top 15 story IDs
}

// Function to fetch story details
async function fetchStoryDetails(storyId) {
    const url = `https://hacker-news.firebaseio.com/v0/item/${storyId}.json`;
    const response = await axios.get(url);
    return response.data;
}

// Function to summarize comments using ChatGPT API
async function summarizeComments(comments) {
    const messages = [
        { role: 'system', content: 'You are an assistant summarizing comments from Hacker News as a teet with a snarky but informed tone. The summary should be in the style of an executive summary. Make sure to include a basic sentiment analysis of the link and include the general vibe of the comments. Use an emojii to express the general feelings about the news story in general. Limit this summary to less than 125 characters or letters' },
        { role: 'user', content: `Summarize the following comments in less than 125 characters: ${comments}` },
    ];

    const response = await axios.post(
        OPENAI_API_URL,
        {
            model: 'gpt-4o-mini',
            messages: messages,
        },
        {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
        }
    );

    return response.data.choices[0].message.content;
}

// Function to check if a story has been processed
function isStoryProcessed(storyId) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT 1 FROM news_data WHERE storyId = ?`, [storyId], (err, row) => {
            if (err) reject(err);
            resolve(!!row);
        });
    });
}

// Function to save story details and comment summary to the database
function saveStoryToDatabase(storyId, title, url, commentSummary) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO news_data (storyId, title, url, commentSummary) VALUES (?, ?, ?, ?)`,
            [storyId, title, url, commentSummary],
            (err) => {
                if (err) reject(err);
                resolve();
            }
        );
    });
}

// Function to retrieve the top item in a stack-like manner
function getTopNewsItem() {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT id, storyId, title, url, commentSummary FROM news_data WHERE retrieved = 0 ORDER BY id ASC LIMIT 1`,
            (err, row) => {
                if (err) reject(err);
                if (row) {
                    // Mark the item as retrieved
                    db.run(
                        `UPDATE news_data SET retrieved = 1 WHERE id = ?`,
                        [row.id],
                        (updateErr) => {
                            if (updateErr) reject(updateErr);
                            resolve(row);
                        }
                    );
                } else {
                    resolve(null); // No unretrieved items
                }
            }
        );
    });
}

// Main Function
async function main() {
    initializeDatabase();
    const storyIds = await fetchTopStories();

    for (const storyId of storyIds) {
        // Check if the story is already processed
        if (await isStoryProcessed(storyId)) {
            continue;
        }

        const story = await fetchStoryDetails(storyId);

        if (!story || !story.kids || !story.url) {
            console.log(`Skipping story ${storyId} (no comments or URL).`);
            continue;
        }

        // Fetch comments for the story
        const comments = [];
        for (const commentId of story.kids.slice(0, 25)) { // Fetch up to 5 top comments
            const commentDetails = await fetchStoryDetails(commentId);
            if (commentDetails && commentDetails.text) {
                comments.push(commentDetails.text);
            }
        }

        // Summarize comments
        const commentSummary = await summarizeComments(comments.join('\n'));

        // Save the story to the database
        await saveStoryToDatabase(storyId, story.title, story.url, commentSummary);
        console.log(`Saved story: ${story.title}`);
    }

    await testRetrieval();
}

// Function to test retrieving the top news item
async function testRetrieval() {
    const topNewsItem = await getTopNewsItem();
    if (topNewsItem) {
        console.log('Retrieved News Item:', topNewsItem);

	let msg = "📰 " + topNewsItem.title + "\r\n\r\n"
	    msg = msg + "💬 " + topNewsItem.commentSummary;
	    msg = msg + "\r\n\r\nhttps://news.ycombinator.com/item?id=" + topNewsItem.storyId

	await agent.login({ 
	  identifier: process.env.BLUESKY_USERNAME, 
	  password: process.env.BLUESKY_PASSWORD
	})
	 
	const rt = new RichText({
	  text: msg,
	})
	await rt.detectFacets()
	
	    console.log('Skeet: ', rt)

	await agent.post({
	    text: rt.text, // The post text with rich formatting
	    facets: rt.facets, // Include the facets for the link
	    createdAt: new Date().toISOString(), // Optional: specify creation time
	});

    } else {
        console.log('No unretrieved news items available.');
    }
}

// Run the script
(async () => {
  await main();
  
  // Run this on a cron job
  const scheduleExpression = '*/5 * * * *';

  const job = new CronJob(scheduleExpression, main);
  job.start();
})();

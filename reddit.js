const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const { BskyAgent, RichText, AppBskyRichtextFacet } = require('@atproto/api');

require('dotenv').config();
require('process');
const { CronJob } = require('cron');

// Set up Reddit and OpenAI API credentials
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
const REDDIT_USER_AGENT = process.env.REDDIT_USER_AGENT;

// OpenAI API Setup
const OPENAI_API_KEY = process.env.REDDIT_OPENAI_API_KEY;
const OPENAI_API_URL = process.env.REDDIT_OPENAI_API_URL;

// Set up Bluesky credentials
const BLUESKY_HANDLE = process.env.REDDIT_BLUESKY_HANDLE;
const BLUESKY_PASSWORD = process.env.REDDIT_BLUESKY_PASSWORD;
const BLUESKY_BASE_URL = process.env.REDDIT_BLUESKY_BASE_URL;

// Create a Bluesky Agent 
const agent = new BskyAgent({
    service: BLUESKY_BASE_URL,
})

// Initialize SQLite Database
const db = new sqlite3.Database("./posts.db", (err) => {
  if (err) console.error("Database error:", err.message);
});

// Create a table to store post details and summaries
db.run(
  `CREATE TABLE IF NOT EXISTS processed_posts (
    id TEXT PRIMARY KEY,
    title TEXT,
    url TEXT,
    summary TEXT,
    retrieved INTEGER DEFAULT 0
  )`,
  (err) => {
    if (err) console.error("Table creation error:", err.message);
  }
);

// Fetch the most recent posts from r/losangeles
async function fetchRecentPosts() {
  const authResponse = await axios.post(
    "https://www.reddit.com/api/v1/access_token",
    "grant_type=client_credentials",
    {
      auth: {
        username: REDDIT_CLIENT_ID,
        password: REDDIT_CLIENT_SECRET,
      },
      headers: {
        "User-Agent": REDDIT_USER_AGENT,
      },
    }
  );

  const accessToken = authResponse.data.access_token;
  const postsResponse = await axios.get(
    "https://oauth.reddit.com/r/losangeles/new?limit=7",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": REDDIT_USER_AGENT,
      },
    }
  );

  return postsResponse.data.data.children.map((post) => ({
    id: post.data.id,
    title: post.data.title,
    url: `https://www.reddit.com${post.data.permalink}`,
    selftext: post.data.selftext,
  }));
}

async function summarizeTitle(text) {
    const comments = [
        { role: 'system', content: 'You are an assistant summarizing the title of a Reddit Post with a snarky but informed tone. Limit this summary to less than 80 characters or letters.' },
        { role: 'user', content: `Summarize the following post title in less than 80 characters: ${text}` },
    ];

    const response = await axios.post(
        OPENAI_API_URL,
        {
            model: 'gpt-4o-mini',
            messages: comments,
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

// Function to summarize comments using ChatGPT API
async function summarizeDiscussion(text) {
    const comments = [
        { role: 'system', content: 'You are an assistant summarizing comments from Reddit Posts as a tweet with a snarky but informed tone. The summary should be in the style of an executive summary. Make sure to include a basic sentiment analysis of the post and include the general vibe of the comments. Use an emojii to express the general feelings about the post in general. Limit this summary to less than 125 characters or letters.' },
        { role: 'user', content: `Summarize the following post discussion in less than 125 characters: ${text}` },
    ];

    const response = await axios.post(
        OPENAI_API_URL,
        {
            model: 'gpt-4o-mini',
            messages: comments,
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


// Post to Bluesky
async function postToBluesky(content) {
  try {

    await agent.login({ 
      identifier: BLUESKY_HANDLE, 
      password: BLUESKY_PASSWORD
    })
	 
    const rt = new RichText({
      text: content,
    })
    await rt.detectFacets()
    
    console.log('Skeet: ', rt)

    await agent.post({
        text: rt.text, // The post text with rich formatting
        facets: rt.facets, // Include the facets for the link
        createdAt: new Date().toISOString(), // Optional: specify creation time
    });
    console.log("Skeet posted successfully!");
  } catch (error) {
    console.error("Error posting to Bluesky:", error.response?.data || error.message);
  }
}

// Retrieve and post the most recent unretrieved post
function retrieveAndPost() {
  db.get(
    "SELECT id, title, url, summary FROM processed_posts WHERE retrieved = 0 ORDER BY ROWID ASC LIMIT 1",
    async (err, row) => {
      if (err) {
        console.error("Database retrieval error:", err.message);
        return;
      }

      if (row) {

        const content = `📰 ${row.title}\n\n💬 ${row.summary}\n\nhttps://www.reddit.com/r/LosAngeles/comments/${row.id}`;
        console.log("Preparing to post the following to Bluesky:\n", content);

        await postToBluesky(content);

        // Mark the post as retrieved
        db.run(
          "UPDATE processed_posts SET retrieved = 1 WHERE id = ?",
          [row.id],
          (updateErr) => {
            if (updateErr) console.error("Database update error:", updateErr.message);
            else console.log(`Post with ID ${row.id} marked as retrieved.`);
          }
        );
      } else {
        console.log("No unretrieved posts available.");
      }
    }
  );
}

// Process new posts
async function processPosts() {
  const posts = await fetchRecentPosts();

  posts.forEach((post) => {
    db.get(
      "SELECT id FROM processed_posts WHERE id = ?",
      [post.id],
      async (err, row) => {
        if (err) {
          console.error("Database read error:", err.message);
          return;
        }

        if (!row) {
          // Summarize and store the post
          const title = await summarizeTitle(post.title);
          const summary = await summarizeDiscussion(post.selftext || post.title);
          console.log(`Title: ${title}\nSummary: ${summary}\n`);

          db.run(
            "INSERT INTO processed_posts (id, title, url, summary) VALUES (?, ?, ?, ?)",
            [post.id, post.title, post.url, summary],
            (err) => {
              if (err) console.error("Database insert error:", err.message);
            }
          );
        } else {
          console.log(`Post already processed: ${post.title}`);
        }
      }
    );
  });
}

// Run the app
async function main() {
  await processPosts();
  setTimeout(() => retrieveAndPost(), 5000);
}

// Start the script
//main().catch((err) => console.error("App error:", err.message));

// Run the script
(async () => {
  await main().catch((err) => console.error("App error:", err.message));
  
  // Run this on a cron job
  const scheduleExpression = '*/5 * * * *';

  const job = new CronJob(scheduleExpression, main);
  job.start();
})();

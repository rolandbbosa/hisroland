const REDDIT_BASE = 'https://www.reddit.com';
const MAX_POSTS = 10;
const MIN_UPVOTES = 100;
const MAX_COMMENTS = 10;
const MAX_REPLIES_PER_COMMENT = 50;
const STORAGE_LINKS_KEY = 'redditScraperLinks';
const STORAGE_POSTS_KEY = 'redditScraperPosts';
const FIREBASE_DATABASE_URL = 'https://data-b61c7-default-rtdb.firebaseio.com';

const statusLog = document.getElementById('statusLog');
const postsCount = document.getElementById('postsCount');
const linksCount = document.getElementById('linksCount');
const postsContainer = document.getElementById('postsContainer');
const scrapeButton = document.getElementById('scrapeButton');
const clearLinksButton = document.getElementById('clearLinksButton');
const downloadJsonButton = document.getElementById('downloadJsonButton');
const downloadLinksButton = document.getElementById('downloadLinksButton');
const postButton = document.getElementById('postButton');

function log(message) {
  const now = new Date().toLocaleTimeString();
  statusLog.textContent = `${now} — ${message}`;
}

function appendLog(message) {
  statusLog.textContent += `\n${message}`;
}

function loadSavedLinks() {
  try {
    const raw = localStorage.getItem(STORAGE_LINKS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (error) {
    console.warn('Failed to load links:', error);
    return new Set();
  }
}

function saveSavedLinks(links) {
  localStorage.setItem(STORAGE_LINKS_KEY, JSON.stringify(Array.from(links)));
}

function loadSavedPosts() {
  try {
    const raw = localStorage.getItem(STORAGE_POSTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (error) {
    console.warn('Failed to load saved posts:', error);
    return [];
  }
}

function savePosts(posts) {
  localStorage.setItem(STORAGE_POSTS_KEY, JSON.stringify(posts));
}

function generateId() {
  const timestampHex = Math.floor(Date.now()).toString(16);
  const randomHex = Math.floor(Math.random() * 0x100000).toString(16).padStart(5, '0');
  return `${timestampHex}${randomHex}`;
}

function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractFirstImageUrl(message) {
  if (!message) return null;
  const match = message.match(/https?:\/\/[^\s]+\.(jpg|jpeg|png|webp)/i);
  return match ? match[0] : null;
}

async function firebasePut(path, data) {
  const url = `${FIREBASE_DATABASE_URL}/${path}.json`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error(`Firebase error ${response.status}`);
  }
  return response.json();
}

async function postRepliesToFirebase(postId, parentCommentId, replies) {
  if (!Array.isArray(replies) || replies.length === 0) {
    return [];
  }

  const postedReplyIds = [];
  for (const reply of replies) {
    const replyId = generateId();
    const replyData = {
      id: replyId,
      post_id: postId,
      parent_id: parentCommentId,
      text: sanitizeText(reply.body || ''),
      anon: `Anon${Math.floor(1000 + Math.random() * 9000)}`,
      timestamp: Math.floor(Date.now() / 1000),
    };
    await firebasePut(`comments/${replyId}`, replyData);
    postedReplyIds.push(replyId);
    if (Array.isArray(reply.replies) && reply.replies.length > 0) {
      const nestedIds = await postRepliesToFirebase(postId, replyId, reply.replies);
      postedReplyIds.push(...nestedIds);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return postedReplyIds;
}

async function postCommentsToFirebase(postId, comments) {
  if (!Array.isArray(comments) || comments.length === 0) {
    return [];
  }

  const postedCommentIds = [];
  for (const comment of comments) {
    const commentId = generateId();
    const commentData = {
      id: commentId,
      post_id: postId,
      parent_id: null,
      text: sanitizeText(comment.body || ''),
      anon: `Anon${Math.floor(1000 + Math.random() * 9000)}`,
      timestamp: Math.floor(Date.now() / 1000),
    };
    await firebasePut(`comments/${commentId}`, commentData);
    postedCommentIds.push(commentId);
    if (Array.isArray(comment.replies) && comment.replies.length > 0) {
      await postRepliesToFirebase(postId, commentId, comment.replies);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return postedCommentIds;
}

async function postSinglePost(postData) {
  if (postData.posted) {
    return false;
  }

  const postId = generateId();
  const title = postData.title || 'Untitled';
  const selftext = postData.selftext || '';
  const mediaUrl = postData.media_url || '';
  const messageParts = [];
  if (selftext) messageParts.push(selftext);
  if (mediaUrl) messageParts.push(mediaUrl);
  const message = messageParts.join('\n');
  const postPayload = {
    post_id: postId,
    title: sanitizeText(title),
    message,
    thumb: extractFirstImageUrl(message),
    anon: `Anon${Math.floor(1000 + Math.random() * 9000)}`,
    timestamp: Math.floor(Date.now() / 1000),
  };

  await firebasePut(`posts/${postId}`, postPayload);
  if (Array.isArray(postData.comments) && postData.comments.length > 0) {
    await postCommentsToFirebase(postId, postData.comments);
  }

  postData.posted = true;
  postData.firebase_id = postData.id || postId;
  return true;
}

async function postAllScrapedPosts() {
  try {
    postButton.disabled = true;
    log('Posting scraped posts to Firebase...');

    const posts = loadSavedPosts();
    const unpostedPosts = posts.filter((post) => !post.posted);
    if (unpostedPosts.length === 0) {
      log('No unposted scraped posts found.');
      postButton.disabled = false;
      return;
    }

    let postedCount = 0;
    for (let index = 0; index < unpostedPosts.length; index += 1) {
      const post = unpostedPosts[index];
      appendLog(`Posting ${index + 1}/${unpostedPosts.length}: ${post.title}`);
      try {
        const success = await postSinglePost(post);
        if (success) {
          postedCount += 1;
          appendLog(`Posted: ${post.title}`);
        } else {
          appendLog(`Skipped already-posted: ${post.title}`);
        }
      } catch (error) {
        appendLog(`Error posting ${post.title}: ${error.message}`);
      }
      savePosts(posts);
      updateStats();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    renderPosts(posts);
    updateStats();
    log(`Finished posting ${postedCount}/${unpostedPosts.length} posts.`);
  } catch (error) {
    log(`Error: ${error.message}`);
  } finally {
    postButton.disabled = false;
  }
}

function updateStats() {
  const posts = loadSavedPosts();
  const links = loadSavedLinks();
  postsCount.textContent = posts.length;
  linksCount.textContent = links.size;
}

async function fetchJson(url, params = {}, retries = 3, delay = 2000) {
  const query = new URLSearchParams(params).toString();
  const fullUrl = query ? `${url}?${query}` : url;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(fullUrl, { mode: 'cors' });
      if (response.status === 429 && attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json();
    } catch (error) {
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      throw error;
    }
  }
  return null;
}

function getMediaUrl(postData) {
  if (postData.is_video) {
    const redditVideo = postData.secure_media?.reddit_video ?? {};
    return redditVideo.fallback_url || null;
  }

  if (postData.post_hint === 'image') {
    return postData.url_overridden_by_dest || postData.url || null;
  }

  const preview = postData.preview;
  if (preview && typeof preview === 'object') {
    const images = preview.images;
    if (Array.isArray(images) && images.length > 0) {
      return images[0].source?.url || null;
    }
  }

  if (['rich:video', 'hosted:video'].includes(postData.post_hint)) {
    return postData.url;
  }

  const url = postData.url;
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
    const ext = url.toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.gifv', '.mp4', '.webm'].some((suffix) => ext.endsWith(suffix))) {
      return url;
    }
  }

  return null;
}

function normalizePost(item) {
  const data = item.data;
  const post = {
    id: data.id,
    title: data.title,
    subreddit: data.subreddit,
    author: data.author,
    score: data.score,
    created_utc: data.created_utc,
    permalink: `${REDDIT_BASE}${data.permalink}`,
    num_comments: data.num_comments,
    url: data.url,
    selftext: data.selftext,
  };
  const mediaUrl = getMediaUrl(data);
  if (mediaUrl) {
    post.media_url = mediaUrl;
  }
  return post;
}

function parseCommentNode(node, repliesLeft) {
  const data = node.data || {};
  const comment = {
    id: data.id,
    author: data.author,
    body: data.body,
    score: data.score,
    created_utc: data.created_utc,
    replies: [],
  };

  const repliesData = data.replies;
  if (repliesData && typeof repliesData === 'object' && repliesLeft.count > 0) {
    const children = repliesData.data?.children || [];
    for (const child of children) {
      if (repliesLeft.count <= 0) {
        break;
      }
      if (child.kind !== 't1') {
        continue;
      }
      comment.replies.push(parseCommentNode(child, repliesLeft));
      repliesLeft.count -= 1;
    }
  }

  return comment;
}

async function scrapeComments(permalink) {
  const commentsUrl = `${REDDIT_BASE}${permalink}.json`;
  const response = await fetchJson(commentsUrl, { limit: 200, depth: 5 });
  if (!Array.isArray(response) || response.length < 2) {
    return [];
  }

  const commentsData = response[1].data?.children || [];
  const comments = [];
  for (const child of commentsData) {
    if (comments.length >= MAX_COMMENTS) {
      break;
    }
    if (child.kind !== 't1') {
      continue;
    }
    const repliesLeft = { count: MAX_REPLIES_PER_COMMENT };
    comments.push(parseCommentNode(child, repliesLeft));
  }
  return comments;
}

async function scrapeHotPosts() {
  const posts = [];
  let after = null;
  const scrapedLinks = loadSavedLinks();
  let skippedCount = 0;

  while (posts.length < MAX_POSTS) {
    const params = { limit: 100, over_18: 1 };
    if (after) {
      params.after = after;
    }

    const url = `${REDDIT_BASE}/r/all/hot/.json`;
    const page = await fetchJson(url, params);
    if (!page || typeof page !== 'object') {
      break;
    }

    const children = page.data?.children || [];
    after = page.data?.after;
    if (!children.length) {
      break;
    }

    for (const item of children) {
      if (posts.length >= MAX_POSTS) {
        break;
      }
      const data = item.data || {};
      if (data.score < MIN_UPVOTES) {
        continue;
      }
      const permalink = `${REDDIT_BASE}${data.permalink}`;
      if (scrapedLinks.has(permalink)) {
        skippedCount += 1;
        continue;
      }
      posts.push(normalizePost(item));
    }

    if (!after) {
      break;
    }
  }

  if (skippedCount > 0) {
    appendLog(`Skipped ${skippedCount} already-scraped posts.`);
  }

  return posts;
}

function renderPosts(posts) {
  if (!posts || posts.length === 0) {
    postsContainer.innerHTML = '<p class="empty-state">No posts found.</p>';
    return;
  }

  postsContainer.innerHTML = posts
    .map((post) => {
      const media = post.media_url
        ? `<div class="post-preview">${renderMedia(post.media_url)}</div>`
        : '';
      const body = post.selftext ? `<p>${escapeHtml(post.selftext)}</p>` : '';
      const commentsList = renderComments(post.comments || []);
      const postStatus = post.posted ? '<span class="post-status">Posted</span>' : '';

      return `
        <article class="post-card">
          <header>
            <div class="post-heading-row">
              <h3>${escapeHtml(post.title)}</h3>
              ${postStatus}
            </div>
            <div class="post-meta">
              <span>r/${escapeHtml(post.subreddit)}</span>
              <span>u/${escapeHtml(post.author)}</span>
              <span>score: ${post.score}</span>
              <span>comments: ${post.num_comments}</span>
              <a class="post-link" href="${escapeHtml(post.permalink)}" target="_blank" rel="noopener noreferrer">Open on Reddit</a>
            </div>
          </header>
          ${media}
          ${body}
          <div>
            <strong>Top comments</strong>
            ${commentsList}
          </div>
        </article>
      `;
    })
    .join('');
}

function renderMedia(mediaUrl) {
  const lower = mediaUrl.toLowerCase();
  if (lower.endsWith('.mp4') || lower.endsWith('.webm')) {
    return `<video controls muted playsinline src="${escapeHtml(mediaUrl)}"></video>`;
  }
  return `<img src="${escapeHtml(mediaUrl)}" alt="Post media preview" />`;
}

function renderComments(comments) {
  if (!comments.length) {
    return '<p class="empty-state">No comments loaded.</p>';
  }
  return `<ul class="comments-list">${comments.map(renderComment).join('')}</ul>`;
}

function renderComment(comment) {
  const replies = comment.replies && comment.replies.length ? `<ul class="replies-list">${comment.replies.map(renderComment).join('')}</ul>` : '';
  return `
    <li class="comment-item">
      <div class="comment-meta">
        <span>u/${escapeHtml(comment.author || '[deleted]')}</span>
        <span>score: ${comment.score ?? 0}</span>
      </div>
      <div class="comment-body">${escapeHtml(comment.body || '')}</div>
      ${replies}
    </li>
  `;
}

function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

async function runScrape() {
  try {
    scrapeButton.disabled = true;
    log('Scraping Reddit hot posts...');
    const savedLinks = loadSavedLinks();
    const posts = await scrapeHotPosts();
    log(`Found ${posts.length} new posts with at least ${MIN_UPVOTES} upvotes.`);

    for (let index = 0; index < posts.length; index += 1) {
      const post = posts[index];
      appendLog(`Scraping comments for post ${index + 1}/${posts.length}: ${post.id}`);
      post.comments = await scrapeComments(post.permalink.replace(REDDIT_BASE, ''));
      savedLinks.add(post.permalink);
      saveSavedLinks(savedLinks);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const existing = loadSavedPosts();
    const allPosts = existing.concat(posts);
    savePosts(allPosts);
    renderPosts(allPosts);
    updateStats();
    log(`Saved scraped data to localStorage as ${STORAGE_POSTS_KEY}.`);
    appendLog(`Saved ${savedLinks.size} total post links to localStorage.`);
  } catch (error) {
    log(`Error: ${error.message}`);
  } finally {
    scrapeButton.disabled = false;
  }
}

function clearStoredLinks() {
  localStorage.removeItem(STORAGE_LINKS_KEY);
  localStorage.removeItem(STORAGE_POSTS_KEY);
  updateStats();
  renderPosts([]);
  log('Cleared stored links and saved post data.');
}

function downloadJsonData() {
  const posts = loadSavedPosts();
  const blob = new Blob([JSON.stringify({ posts }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'data.json';
  link.click();
  URL.revokeObjectURL(url);
}

function downloadLinksFile() {
  const links = Array.from(loadSavedLinks()).join('\n');
  const blob = new Blob([links], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'links.txt';
  link.click();
  URL.revokeObjectURL(url);
}

scrapeButton.addEventListener('click', runScrape);
clearLinksButton.addEventListener('click', clearStoredLinks);
downloadJsonButton.addEventListener('click', downloadJsonData);
downloadLinksButton.addEventListener('click', downloadLinksFile);
postButton.addEventListener('click', postAllScrapedPosts);

window.addEventListener('DOMContentLoaded', () => {
  updateStats();
  renderPosts(loadSavedPosts());
});

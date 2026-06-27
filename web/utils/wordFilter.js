const { pool } = require('../config/db');

class WordFilter {
  constructor() {
    this.forbiddenWords = [];
    this.lastFetched = 0;
    this.cacheTime = 60000; // Cache for 1 minute
  }

  async fetchWords() {
    if (Date.now() - this.lastFetched < this.cacheTime && this.forbiddenWords.length > 0) {
      return this.forbiddenWords;
    }

    try {
      const [settings] = await pool.query('SELECT setting_value FROM system_settings WHERE setting_key = "forbidden_words"');
      if (settings.length > 0 && settings[0].setting_value) {
        this.forbiddenWords = settings[0].setting_value
          .split(',')
          .map(w => w.trim().toLowerCase())
          .filter(w => w.length > 0);
      } else {
        this.forbiddenWords = [];
      }
      this.lastFetched = Date.now();
    } catch (e) {
      console.error('Error fetching forbidden words:', e);
    }
    return this.forbiddenWords;
  }

  async filter(text) {
    if (!text) return text;
    const words = await this.fetchWords();
    if (words.length === 0) return text;

    let filteredText = text;
    for (const word of words) {
      // Use regex with word boundaries if you want exact match, or just global replace.
      // Replacing partial matches:
      const regex = new RegExp(word, 'gi');
      filteredText = filteredText.replace(regex, '***');
    }
    return filteredText;
  }

  async containsBadWords(text) {
    if (!text) return false;
    const words = await this.fetchWords();
    if (words.length === 0) return false;

    const lowerText = text.toLowerCase();
    for (const word of words) {
      if (lowerText.includes(word)) {
        return true;
      }
    }
    return false;
  }
}

const wordFilter = new WordFilter();
module.exports = wordFilter;

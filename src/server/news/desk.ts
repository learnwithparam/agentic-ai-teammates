// What each company's news teammate reads, and who the news is for. The model picks stories
// for this audience; a person's instructions in memory sharpen it.

export type Feed = { name: string; url: string };

export type NewsDesk = {
  audience: string;
  feeds: Feed[];
  // Hacker News front-page stories at or above this score.
  hackerNewsMinScore: number;
  // A GDELT DOC 2.0 query, from https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/.
  gdeltQuery: string;
  // What Exa searches for. Exa runs only when EXA_API_KEY is set.
  exaQuery: string;
};

export const NEWS_DESKS: Record<string, NewsDesk> = {
  bramble: {
    audience:
      "Bramble Studio, a small design studio in Amsterdam. Its people care about design tools, AI in creative work, how studios find and price client work, and EU rules that touch a small business.",
    feeds: [
      { name: "Creative Boom", url: "https://www.creativeboom.com/feed/" },
      { name: "Creative Bloq", url: "https://www.creativebloq.com/feeds/all" },
      { name: "Dezeen", url: "https://www.dezeen.com/feed/" },
      { name: "Smashing Magazine", url: "https://www.smashingmagazine.com/feed/" },
      { name: "UX Collective", url: "https://uxdesign.cc/feed" },
      { name: "Sifted", url: "https://sifted.eu/feed" },
    ],
    hackerNewsMinScore: 150,
    gdeltQuery: '("design studio" OR "creative agency" OR "graphic design" OR "design tool") sourcelang:english',
    exaQuery: "News this week for small design studios: design tools, AI in creative work, and running a studio in Europe",
  },
};

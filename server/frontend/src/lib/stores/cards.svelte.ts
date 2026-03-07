import type { HistoryCard } from "../../types";
import { fetchJSON } from "../api";

interface CardsResponse {
  cards: HistoryCard[];
}

let cards = $state<HistoryCard[]>([]);

export function getCards(): HistoryCard[] {
  return cards;
}

export function addCard(card: HistoryCard): void {
  // Deduplicate by sessionId+endTime composite key
  const key = `${card.sessionId}-${card.endTime}`;
  const exists = cards.some(c => `${c.sessionId}-${c.endTime}` === key);
  if (!exists) {
    cards = [card, ...cards].slice(0, 50);
  }
}

export async function fetchCards(limit: number = 50): Promise<void> {
  try {
    const data = await fetchJSON<CardsResponse>(`/api/history?limit=${limit}`);
    cards = data.cards ?? [];
  } catch (e) {
    console.error("Failed to fetch cards:", e);
  }
}

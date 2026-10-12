/**
 * A link to one of the user's own accounts (Google Calendar, Gmail, Spotify, a bank...).
 * Capabilities read through connectors and are only offered once the user has connected.
 * Tokens are the user's; they never leave this service and never reach the model.
 */
export interface Connector {
    id: string;
    isConnected(userId: string): Promise<boolean>;
}

export interface CalendarEvent {
    id: string;
    title: string;
    start: string;
    end: string;
    location?: string;
}

export interface CalendarConnector extends Connector {
    listEvents(userId: string, from: Date, to: Date): Promise<CalendarEvent[]>;
}

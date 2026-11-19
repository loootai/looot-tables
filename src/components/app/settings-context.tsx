'use client';

import { serverKeys, type ServerKeys } from '@/lib/api';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, saveOrganizationSettings, type Settings, subscribeSettings, initializeOrganizationSettings, refreshOrganizationSettings, organizationSettingsSnapshot, localSettingsToImport, importLocalOrganizationSettings, disconnectOrganizationProvider, organizationSettingsEnabled } from '@/lib/keys';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { providerField, type OrganizationSettings, type Provider } from '@/lib/organization-settings';
import { OPENAI_KEY_REQUIRED_EVENT } from '@/lib/ai-trial';
import { deriveConnections, isReady, type Connection } from './providers';

interface SettingsContextValue {
	selfHosted: boolean;
	/** Hosted Context.dev sign-in: a missing or expired Context.dev connection is fixed by reconnecting, not by pasting a key. */
	contextSignIn: boolean;
	workspaceName: string;
	trialLimitMessage: string | null;
	reportTrialLimit: (message: string) => void;
	settings: Settings;
	logolinkPublicId?: string;
	update: (patch: Partial<Settings>, expectedRevision?: number) => Promise<void>;
	organization: OrganizationSettings | null;
	settingsError: string | null;
	retrySettings: () => void;
	canImportSettings: boolean;
	importSettings: () => Promise<void>;
	disconnectProvider: (provider: Provider) => Promise<void>;
	server: ServerKeys | null;
	connections: Record<Provider, Connection>;
	ready: boolean;
	/** Context.dev and OpenAI, which Find rows needs. Runs ask `providerReady` for just the providers their operations need. */
	hasKeys: boolean;
	providerReady: (provider: Provider) => boolean;
	hasJev: boolean;
	keysOpen: boolean;
	openKeys: () => void;
	closeKeys: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

const serverSnapshot = () => DEFAULT_SETTINGS;

export function SettingsProvider({ children, logolinkPublicId, selfHosted = false, contextSignIn = false, workspaceName = '' }: { children: ReactNode; logolinkPublicId?: string; selfHosted?: boolean; contextSignIn?: boolean; workspaceName?: string }) {
	const settings = useSyncExternalStore(subscribeSettings, loadSettings, serverSnapshot);
	const [settingsError, setSettingsError] = useState<string | null>(null);
	const organization = organizationSettingsSnapshot();
	const [server, setServer] = useState<ServerKeys | null>(null);
	const [ready, setReady] = useState(false);
	const [keysOpen, setKeysOpen] = useState(false);
	const [trialLimitMessage, setTrialLimitMessage] = useState<string | null>(null);
	const promptedLimit = useRef<string | null>(null);
	const reportTrialLimit = useCallback((message: string) => {
		if (loadSettings().openaiKey || organizationSettingsSnapshot()?.providers.openai?.configured || promptedLimit.current === message) return;
		promptedLimit.current = message;
		setTrialLimitMessage(message);
		setKeysOpen(true);
	}, []);
	useEffect(() => {
		const listener = (event: Event) => reportTrialLimit((event as CustomEvent<string>).detail);
		window.addEventListener(OPENAI_KEY_REQUIRED_EVENT, listener);
		return () => window.removeEventListener(OPENAI_KEY_REQUIRED_EVENT, listener);
	}, [reportTrialLimit]);
	// One loader for the first load, background refreshes and Retry: a later success always clears the error and marks the app ready.
	const sync = useRef<() => Promise<void>>(async () => {});
	useEffect(() => {
		let cancelled = false;
		let loaded = false;
		sync.current = async () => {
			try {
				if (!selfHosted) await (loaded ? refreshOrganizationSettings() : initializeOrganizationSettings());
				const value = await serverKeys();
				loaded = true;
				if (!cancelled) { setServer(value); setSettingsError(null); setReady(true); }
			} catch (error) { if (!cancelled) setSettingsError(error instanceof Error ? error.message : 'Could not load workspace settings.'); }
		};
		void sync.current();
		const focus = () => { void sync.current(); };
		const timer = setInterval(() => { if (document.visibilityState === 'visible') void sync.current(); }, 30_000);
		window.addEventListener('focus', focus);
		return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', focus); };
	}, [selfHosted]);
	const retrySettings = useCallback(() => { void sync.current(); }, []);
	const update = useCallback(async (patch: Partial<Settings>, expectedRevision?: number) => {
		if (expectedRevision !== undefined) await saveOrganizationSettings(patch, expectedRevision); else await saveSettings(patch);
		setServer(await serverKeys());
	}, []);
	const importSettings = useCallback(async () => { await importLocalOrganizationSettings(); setServer(await serverKeys()); }, []);
	const disconnectProvider = useCallback(async (provider: Provider) => {
		if (organizationSettingsEnabled()) await disconnectOrganizationProvider(provider);
		else await saveSettings({ [providerField[provider]]: '' });
		setServer(await serverKeys());
	}, []);
	const connections = useMemo(() => deriveConnections({ settings, organization, server, selfHosted, trialLimited: Boolean(trialLimitMessage) }), [settings, organization, server, selfHosted, trialLimitMessage]);
	// A key of the member's own replaces the trial, so its limit no longer applies.
	const activeTrialLimit = connections.openai.state === 'connected' || connections.openai.state === 'saved' ? null : trialLimitMessage;
	const hasKeys = isReady(connections.context) && isReady(connections.openai);
	const providerReady = useCallback((provider: Provider) => isReady(connections[provider]), [connections]);
	const hasJev = connections.typesafe.state !== 'missing' && connections.typesafe.state !== 'expired';
	const openKeys = useCallback(() => setKeysOpen(true), []);
	const closeKeys = useCallback(() => setKeysOpen(false), []);
	const value = useMemo<SettingsContextValue>(() => ({ selfHosted, contextSignIn, workspaceName, settings, update, organization, settingsError, retrySettings, canImportSettings: Boolean(localSettingsToImport()), importSettings, disconnectProvider, server, connections, ready, hasKeys, providerReady, hasJev, logolinkPublicId, keysOpen, trialLimitMessage: activeTrialLimit, reportTrialLimit, openKeys, closeKeys }), [selfHosted, contextSignIn, workspaceName, settings, update, organization, settingsError, retrySettings, importSettings, disconnectProvider, server, connections, ready, hasKeys, providerReady, hasJev, logolinkPublicId, keysOpen, activeTrialLimit, reportTrialLimit, openKeys, closeKeys]);
	return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
	const context = useContext(SettingsContext);
	if (!context) throw new Error('useSettings must be used inside SettingsProvider');
	return context;
}

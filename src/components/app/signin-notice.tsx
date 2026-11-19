'use client';

import { useEffect } from 'react';

export function SigninNotice() {
	useEffect(() => {
		if (typeof BroadcastChannel === 'undefined') return;
		const channel = new BroadcastChannel('enrichable.auth');
		channel.postMessage('changed');
		channel.close();
	}, []);
	return null;
}

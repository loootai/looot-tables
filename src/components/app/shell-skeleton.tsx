/** One loading state for every phase of entering the app (session check, workspace load, first sheets fetch). */
export function ShellSkeleton() {
	return (
		<div aria-busy="true" className="flex h-dvh overflow-clip bg-canvas">
			<div className="hidden h-full w-[212px] shrink-0 flex-col gap-3 px-5 pt-6 pb-5 md:flex">
				<div className="skeleton h-6 w-28 rounded-md" />
				<div className="mt-4 skeleton h-8 rounded-lg" />
				<div className="ml-[38px] skeleton h-6 rounded-md" />
				<div className="ml-[38px] skeleton h-6 rounded-md" />
				<div className="flex-1" />
				<div className="skeleton h-8 rounded-lg" />
				<div className="skeleton h-8 rounded-lg" />
				<div className="skeleton h-14 rounded-lg" />
			</div>
			<div className="flex min-w-0 flex-1 flex-col px-4 pt-[calc(4rem+env(safe-area-inset-top))] sm:px-6 md:px-12 md:pt-10">
				<div className="mx-auto flex w-full max-w-[880px] flex-col gap-7">
					<div className="skeleton h-8 w-40 rounded-md" />
					<div className="grid gap-5 sm:grid-cols-2">
						{[0, 1, 2].map((index) => <div key={index} className="skeleton h-64 rounded-xl" />)}
					</div>
				</div>
			</div>
			<span role="status" className="sr-only">Loading…</span>
		</div>
	);
}

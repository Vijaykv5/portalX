"use client";

import Link from "next/link";
import { useState } from "react";

const command = "npm install -g @vijaykv/portalx";

export default function Home() {
  const [copied, setCopied] = useState(false);

  async function copyCommand() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_50%_0%,#151821_0%,#090a0f_42%,#05060a_100%)] text-white">
      <header className="mx-auto flex w-full max-w-[1440px] items-center justify-between px-5 py-5 sm:px-7 lg:px-9">
        <nav aria-label="Primary" className="flex min-h-11 items-center gap-7">
          <Link
            href="/"
            className="text-[1.35rem] font-bold leading-none tracking-normal text-white transition hover:text-white/80 focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#05060a]"
          >
            Portalx
          </Link>
          <a
            href="https://www.npmjs.com/package/@vijaykv/portalx"
            className="hidden min-h-11 items-center text-sm font-bold uppercase tracking-normal text-white/42 transition hover:text-white/70 focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#05060a] sm:flex"
          >
            npm
          </a>
        </nav>

        <div className="flex items-center gap-3">
          <a
            href="https://github.com/Vijaykv5/portalX"
            aria-label="Open Portalx on GitHub"
            className="flex size-11 items-center justify-center rounded-lg border border-white/12 bg-white/[0.03] text-white/62 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition hover:border-white/24 hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#05060a]"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="size-5"
              fill="currentColor"
            >
              <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.38 7.86 10.9.58.1.79-.25.79-.56v-2.16c-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.27-1.68-1.27-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.24.72-1.53-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.16 1.18.92-.26 1.9-.38 2.88-.39.98 0 1.96.13 2.88.39 2.2-1.49 3.16-1.18 3.16-1.18.62 1.59.23 2.76.11 3.05.74.8 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.25 5.68.41.36.77 1.06.77 2.14v3.17c0 .31.21.67.79.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
            </svg>
          </a>
          <a
            href="https://www.npmjs.com/package/@vijaykv/portalx"
            className="flex min-h-11 items-center rounded-lg border border-white/16 bg-white/[0.03] px-4 text-sm font-bold uppercase tracking-normal text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition hover:border-white/30 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#05060a] sm:px-5"
          >
            Get Portalx
          </a>
        </div>
      </header>

      <section className="mx-auto grid min-h-[calc(100vh-84px)] w-full max-w-[1440px] content-center px-5 pb-20 pt-10 text-center sm:px-7 lg:px-9">
        <div className="mx-auto max-w-5xl">
          <h1 className="mx-auto text-[2.15rem] font-bold uppercase leading-[1.03] tracking-normal text-white sm:text-[3.1rem] md:text-[4.8rem] lg:text-[5.9rem]">
            <span className="block whitespace-nowrap">Share localhost</span>
            <span className="block whitespace-nowrap">with anyone</span>
          </h1>
          <p className="mx-auto mt-7 max-w-xl text-balance text-base font-medium leading-7 tracking-normal text-white/46 sm:text-lg sm:leading-8">
            Create a public URL for local apps, APIs and demos
          </p>
        </div>

        <div className="mx-auto mt-20 w-fit max-w-full sm:mt-24">
          <p className="mb-5 text-sm font-medium tracking-normal text-white/38">
            Start a public localhost tunnel.
          </p>
          <div className="group mx-auto flex max-w-full items-center justify-center gap-4 rounded-2xl border border-white/12 bg-[#101118]/80 px-5 py-4 text-left shadow-2xl shadow-black/25 backdrop-blur sm:px-6">
            <code className="min-w-0 overflow-x-auto whitespace-nowrap font-mono text-sm leading-7 tracking-normal text-white/78 sm:text-base">
              <span className="text-white/42">$ </span>
              {command}
            </code>
            <button
              type="button"
              onClick={copyCommand}
              aria-label={copied ? "Command copied" : "Copy install command"}
              title={copied ? "Copied" : "Copy"}
              className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/70 transition hover:border-white/24 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#101117]"
            >
              {copied ? (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="size-5"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                >
                  <path d="m20 6-11 11-5-5" />
                </svg>
              ) : (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="size-5"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                >
                  <rect width="14" height="14" x="8" y="8" rx="2" />
                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";

const command = "npm install -g @vijaykv/portalx && portalx http 3000";

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
        <nav aria-label="Primary" className="flex min-h-11 items-center gap-8">
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

        <div className="mx-auto mt-20 w-full max-w-3xl sm:mt-24">
          <p className="mb-5 text-sm font-medium tracking-normal text-white/38">
            Start a public localhost tunnel.
          </p>
          <div className="group flex min-h-20 items-center gap-4 rounded-2xl border border-white/12 bg-[#101118]/80 px-5 py-4 text-left shadow-2xl shadow-black/25 backdrop-blur sm:px-7">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm leading-7 tracking-normal text-white/78 sm:text-base">
              <span className="text-white/42">$ </span>
              {command}
            </code>
            <button
              type="button"
              onClick={copyCommand}
              className="min-h-11 shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-4 text-sm font-bold text-white/70 transition hover:border-white/24 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#101117]"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

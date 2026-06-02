import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const interSans = Inter({
  variable: "--font-inter-sans",
  subsets: ["latin"],
});


export const metadata: Metadata = {
  title: "JSON 图表工作台 | ECharts Demo",
  description: "识别 JSON 数组和对象结构并生成 ECharts 图表",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${interSans.variable}  antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

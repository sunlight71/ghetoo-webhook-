export const metadata = {
  title: 'Deposit Webhook',
  description: 'Tatum deposit webhook handler',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

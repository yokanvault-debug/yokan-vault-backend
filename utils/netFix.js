// Node 20+ gives each connection attempt only 250 ms before trying the next address.
// On slow or IPv6-less networks that ends in ETIMEDOUT/ENETUNREACH even though the site is reachable
// (curl works). Be more patient and prefer IPv4.
try { require('dns').setDefaultResultOrder('ipv4first') } catch (e) { /* older Node */ }
try { require('net').setDefaultAutoSelectFamilyAttemptTimeout(8000) } catch (e) { /* older Node */ }

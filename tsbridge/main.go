// tsbridge: an embedded Tailscale node for MausDroid.
// It joins the tailnet in userspace (no VPN permission, no Tailscale app),
// forwards tailnet HTTP traffic to the local engine, and offers a local
// HTTP proxy so the engine can reach other tailnet devices (e.g. your PC).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"tailscale.com/tsnet"
)

type status struct {
	State     string   `json:"state"`
	AuthURL   string   `json:"auth_url,omitempty"`
	IPs       []string `json:"ips,omitempty"`
	DNSName   string   `json:"dns_name,omitempty"`
	Peers     []peer   `json:"peers,omitempty"`
	UpdatedAt string   `json:"updated_at"`
	Error     string   `json:"error,omitempty"`
}

type peer struct {
	Name   string   `json:"name"`
	DNS    string   `json:"dns"`
	IPs    []string `json:"ips"`
	Online bool     `json:"online"`
	OS     string   `json:"os"`
}

func main() {
	stateDir := flag.String("state", "", "state directory")
	hostname := flag.String("hostname", "mausdroid", "tailnet hostname")
	forward := flag.String("forward", "127.0.0.1:8737", "local engine address to expose on tailnet :80")
	proxyAddr := flag.String("proxy", "127.0.0.1:8739", "local HTTP proxy for reaching the tailnet")
	statusFile := flag.String("status", "", "status JSON file")
	flag.Parse()
	if *stateDir == "" {
		log.Fatal("--state is required")
	}
	_ = os.MkdirAll(*stateDir, 0o700)

	srv := &tsnet.Server{
		Dir:      *stateDir,
		Hostname: *hostname,
		AuthKey:  os.Getenv("TS_AUTHKEY"),
		Logf:     func(string, ...any) {},
		UserLogf: log.Printf,
	}
	defer srv.Close()

	writeStatus := func(s status) {
		if *statusFile == "" {
			return
		}
		s.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		b, _ := json.Marshal(s)
		tmp := *statusFile + ".tmp"
		_ = os.WriteFile(tmp, b, 0o600)
		_ = os.Rename(tmp, filepath.Clean(*statusFile))
	}
	writeStatus(status{State: "Starting"})

	if err := srv.Start(); err != nil {
		writeStatus(status{State: "Error", Error: err.Error()})
		log.Fatal(err)
	}
	lc, err := srv.LocalClient()
	if err != nil {
		log.Fatal(err)
	}

	// Status loop.
	go func() {
		for {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			st, err := lc.Status(ctx)
			cancel()
			if err != nil {
				writeStatus(status{State: "Error", Error: err.Error()})
			} else {
				s := status{State: st.BackendState, AuthURL: st.AuthURL}
				if st.Self != nil {
					s.DNSName = st.Self.DNSName
					for _, ip := range st.Self.TailscaleIPs {
						s.IPs = append(s.IPs, ip.String())
					}
				}
				for _, p := range st.Peer {
					pp := peer{Name: p.HostName, DNS: p.DNSName, Online: p.Online, OS: p.OS}
					for _, ip := range p.TailscaleIPs {
						pp.IPs = append(pp.IPs, ip.String())
					}
					s.Peers = append(s.Peers, pp)
				}
				writeStatus(s)
			}
			time.Sleep(5 * time.Second)
		}
	}()

	// Inbound: tailnet :80 -> local engine.
	target, _ := url.Parse("http://" + *forward)
	rp := httputil.NewSingleHostReverseProxy(target)
	rp.FlushInterval = -1
	go func() {
		for {
			ln, err := srv.Listen("tcp", ":80")
			if err != nil {
				log.Printf("listen: %v", err)
				time.Sleep(5 * time.Second)
				continue
			}
			_ = http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				r.Header.Set("X-Mausdroid-Via", "tailnet")
				rp.ServeHTTP(w, r)
			}))
		}
	}()

	// Outbound: local HTTP proxy into the tailnet.
	tr := &http.Transport{DialContext: srv.Dial}
	proxy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodConnect {
			dst, err := srv.Dial(r.Context(), "tcp", r.Host)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadGateway)
				return
			}
			hj, ok := w.(http.Hijacker)
			if !ok {
				dst.Close()
				return
			}
			src, _, err := hj.Hijack()
			if err != nil {
				dst.Close()
				return
			}
			_, _ = src.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
			go func() { _, _ = io.Copy(dst, src); dst.Close() }()
			_, _ = io.Copy(src, dst)
			src.Close()
			return
		}
		r.RequestURI = ""
		resp, err := tr.RoundTrip(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		for k, v := range resp.Header {
			w.Header()[k] = v
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	})
	ln, err := net.Listen("tcp", *proxyAddr)
	if err != nil {
		log.Fatal(err)
	}
	log.Fatal(http.Serve(ln, proxy))
}

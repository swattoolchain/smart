<?php
/**
 * Plugin Name:       Tharam Store Guard
 * Plugin URI:        https://tharam.store/platforms/woocommerce
 * Description:       Lets Tharam's test shopper through your security and caching plugins, and links your store to your Tharam account with a code. Contains no passwords or keys.
 * Version:           0.1.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            Tharam
 * Author URI:        https://tharam.store
 * License:           GPLv2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       tharam-store-guard
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'THARAM_SG_VERSION', '0.1.0' );
define( 'THARAM_SG_AGENT', 'TharamStoreGuard' );

/** True when this request comes from Tharam's test shopper. */
function tharam_sg_is_shopper() {
	$ua = isset( $_SERVER['HTTP_USER_AGENT'] ) ? (string) wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) : '';
	return false !== strpos( $ua, THARAM_SG_AGENT );
}

/** The link code: random, made once, safe to show. It only proves you control this site. */
function tharam_sg_code() {
	$code = get_option( 'tharam_sg_code' );
	if ( ! is_string( $code ) || ! preg_match( '/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/', $code ) ) {
		$chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
		$out   = '';
		for ( $i = 0; $i < 12; $i++ ) {
			$out .= $chars[ random_int( 0, strlen( $chars ) - 1 ) ];
			if ( 3 === $i % 4 && $i < 11 ) {
				$out .= '-';
			}
		}
		$code = $out;
		update_option( 'tharam_sg_code', $code, false );
	}
	return $code;
}
register_activation_hook( __FILE__, 'tharam_sg_code' );

/**
 * Test shopper only: never serve a cached page or a cached cart, so Tharam sees what a first-time visitor sees.
 * Most caching plugins honour these standard switches.
 */
add_action(
	'plugins_loaded',
	function () {
		if ( ! tharam_sg_is_shopper() ) {
			return;
		}
		foreach ( array( 'DONOTCACHEPAGE', 'DONOTCACHEOBJECT', 'DONOTCACHEDB' ) as $flag ) {
			if ( ! defined( $flag ) ) {
				define( $flag, true );
			}
		}
		add_filter( 'wp_headers', function ( $headers ) {
			$headers['Cache-Control'] = 'no-store, max-age=0';
			return $headers;
		} );
	},
	1
);

/**
 * Keep the public WooCommerce Store API (/wp-json/wc/store/) and our own link route open.
 * Some "disable REST API" and security plugins block them for visitors who are not signed in.
 * Only these two public routes are touched; the rest of the REST API stays as you set it.
 */
function tharam_sg_is_public_route() {
	$route = isset( $GLOBALS['wp']->query_vars['rest_route'] ) ? (string) $GLOBALS['wp']->query_vars['rest_route'] : '';
	if ( '' === $route && isset( $_SERVER['REQUEST_URI'] ) ) {
		$route = (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ), PHP_URL_PATH );
	}
	return (bool) preg_match( '#/(wc/store/|tharam/v1/link)#', $route );
}
add_filter(
	'rest_authentication_errors',
	function ( $result ) {
		if ( is_wp_error( $result ) && tharam_sg_is_public_route() && 'GET' === ( $_SERVER['REQUEST_METHOD'] ?? '' ) ) {
			return null;
		}
		return $result;
	},
	99999
);

/** GET /wp-json/tharam/v1/link: shows the link code so Tharam can confirm the store is yours. */
add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			'tharam/v1',
			'/link',
			array(
				'methods'             => 'GET',
				'permission_callback' => '__return_true',
				'callback'            => function () {
					$response = rest_ensure_response(
						array(
							'plugin'      => 'tharam-store-guard',
							'version'     => THARAM_SG_VERSION,
							'code'        => tharam_sg_code(),
							'woocommerce' => class_exists( 'WooCommerce' ),
						)
					);
					$response->header( 'Cache-Control', 'no-store' );
					return $response;
				},
			)
		);
	}
);

/** Settings page: Tools > Tharam. */
add_action(
	'admin_menu',
	function () {
		add_management_page( 'Tharam Store Guard', 'Tharam', 'manage_options', 'tharam-store-guard', 'tharam_sg_page' );
	}
);

function tharam_sg_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$code = tharam_sg_code();
	?>
	<div class="wrap">
		<h1>Tharam Store Guard</h1>
		<p>Tharam shops your store like a customer, around the clock, and tells you in plain words when buying breaks. This plugin makes sure your security and caching plugins let that test shopper in.</p>
		<h2>Link this store to your Tharam account</h2>
		<p>Copy this code into Tharam when you add your WooCommerce store:</p>
		<p><code style="font-size:1.6em;padding:.3em .6em;user-select:all;"><?php echo esc_html( $code ); ?></code></p>
		<p>The code only proves the store is yours. It is not a password and gives no access to your site.</p>
		<h2>What this plugin does</h2>
		<ul style="list-style:disc;margin-left:1.5em;">
			<li>Asks caching plugins not to serve a saved copy of a page to the Tharam test shopper (it identifies itself as <code><?php echo esc_html( THARAM_SG_AGENT ); ?></code>).</li>
			<li>Keeps the public WooCommerce Store API (<code>/wp-json/wc/store/</code>) readable, which Tharam uses to read your products and prices.</li>
			<li>Never changes your settings, never reads orders or customers, and stores nothing except this code.</li>
		</ul>
		<h2>If a security plugin or firewall still blocks Tharam</h2>
		<p>Firewalls like Wordfence, Sucuri, Cloudflare or your host's own protection can't be changed from a plugin. Add a rule that allows visitors whose User Agent contains <code><?php echo esc_html( THARAM_SG_AGENT ); ?></code>. Tharam will tell you in plain words if it still gets stopped.</p>
	</div>
	<?php
}

add_filter(
	'plugin_action_links_' . plugin_basename( __FILE__ ),
	function ( $links ) {
		array_unshift( $links, '<a href="' . esc_url( admin_url( 'tools.php?page=tharam-store-guard' ) ) . '">Link code</a>' );
		return $links;
	}
);

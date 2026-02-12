{
  description = "Development environment for Speech-to-Text Reveal.js Plugin";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_20
          ];

          shellHook = ''
            echo "Speech-to-Text Dev Environment"
            echo "Node.js $(node --version)"
            echo "npm $(npm --version)"
          '';
        };
      }
    );
}
